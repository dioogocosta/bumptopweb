/**
 * Testes dos layouts de pilha — matemática pura (M3).
 * Valida a fórmula ground-truth de `getLogHeightSteps` e o grid 4×4.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_LINEAR_PILE_HEIGHT,
  GRID_PAGE_SIZE,
  gridOffset,
  gridPageCount,
  gridPageItems,
  stackHeightStep,
  stackOffsets,
} from '../../src/core/piles/pileLayout';
import { PileManager } from '../../src/core/piles/pileManager';
import { PileLayout } from '../../src/core/model/types';

describe('stackHeightStep (getLogHeightSteps)', () => {
  it('≤ maxLinear: altura linear constante (2*dims.z)', () => {
    const step = stackHeightStep(3, 1.6);
    expect(step).toBeCloseTo(3.2, 5);
    expect(stackHeightStep(5, 1.6)).toBeCloseTo(3.2, 5);
  });

  it('1 item: step 0 (nada abaixo dele)', () => {
    expect(stackHeightStep(1, 1.6)).toBe(0);
    expect(stackHeightStep(0, 1.6)).toBe(0);
  });

  it('> maxLinear: usa pow(log(1+extra), 2.4) e o step CRESCE menos que linear', () => {
    const halfZ = 1.6;
    const linearStep = 2 * halfZ;
    const big = 40;
    const stepBig = stackHeightStep(big, halfZ);

    // Altura total esperada (fórmula original)
    const extra = big - MAX_LINEAR_PILE_HEIGHT;
    const expectedTotal = Math.pow(Math.log(1 + extra), 2.4) + MAX_LINEAR_PILE_HEIGHT * 2 * halfZ;
    expect(stepBig).toBeCloseTo(expectedTotal / big, 5);

    // Com 40 itens, a altura média por item é MENOR que a pilha 100% linear
    // (contrato do log: comprime pilhas altas)
    const allLinear = big * linearStep;
    const logTotal = expectedTotal;
    expect(logTotal).toBeLessThan(allLinear);
  });

  it('monotonia: altura TOTAL cresce sempre (step/item pode cair no limite 5→6)', () => {
    let prevTotal = 0;
    for (let n = 2; n <= 60; n++) {
      const total = stackHeightStep(n, 1.6) * n;
      expect(total).toBeGreaterThanOrEqual(prevTotal - 1e-9);
      prevTotal = total;
    }
  });
});

describe('stackOffsets', () => {
  it('gera exatamente count posições empilhadas em Y crescente', () => {
    const offs = stackOffsets(6, 1.6);
    expect(offs).toHaveLength(6);
    expect(offs[0].y).toBe(0);
    // Y médio crescente (pequeno jitter em x/z não afeta altura)
    for (let i = 1; i < offs.length; i++) {
      expect(offs[i].y).toBeGreaterThan(offs[i - 1].y);
    }
  });
});

describe('grid (4×4 paginado)', () => {
  it('PAGE_SIZE = 16 (PILE_GRID_ROWSIZE * COLSIZE)', () => {
    expect(GRID_PAGE_SIZE).toBe(16);
  });

  it('gridOffset centraliza a página em 4 colunas × 4 linhas', () => {
    const first = gridOffset(0, 20);
    const fourth = gridOffset(3, 20);
    expect(first.x).toBe(-30); // (0 - 1.5) * 20
    expect(fourth.x).toBe(30);
    expect(gridOffset(15, 20).z).toBe(30); // última linha
    // 16º item volta ao início (segunda página vem do gerenciador)
    expect(gridOffset(16, 20).x).toBe(-30);
  });

  it('gridPageCount faz ceil e manda mínimo 1', () => {
    expect(gridPageCount(1)).toBe(1);
    expect(gridPageCount(16)).toBe(1);
    expect(gridPageCount(17)).toBe(2);
    expect(gridPageCount(33)).toBe(3);
    expect(gridPageCount(0)).toBe(1);
  });

  it('gridPageItems recorta a página correta', () => {
    expect(gridPageItems(40, 0)).toEqual({ start: 0, end: 16 });
    expect(gridPageItems(40, 1)).toEqual({ start: 16, end: 32 });
    expect(gridPageItems(40, 2)).toEqual({ start: 32, end: 40 });
    // Página além do fim → faixa vazia no limite
    expect(gridPageItems(10, 5).start).toBe(10);
  });
});

describe('PileManager', () => {
  const origin = { x: 10, y: 1.6, z: -5 };

  it('create/add/remove e dissolve com <2 itens', () => {
    const pm = new PileManager();
    pm.create('a', 'b', origin);
    expect(pm.contains('a')).toBe(true);
    expect(pm.contains('b')).toBe(true);
    expect(pm.add('a', 'c', origin)).toBe(true);
    expect(pm.add('a', 'a', origin)).toBe(false); // duplicado rejeitado

    // Remove até restar 1 → dissolve
    expect(pm.remove('c').dissolved).toBe(false);
    const r1 = pm.remove('b');
    expect(r1.dissolved).toBe(true);
    expect(pm.contains('a')).toBe(false);
  });

  it('stack: posições crescem em Y com o passo log', () => {
    const pm = new PileManager();
    pm.create('a', 'b', origin);
    pm.add('a', 'c', origin);
    const pA = pm.positionOf('a')!;
    const pC = pm.positionOf('c')!;
    expect(pC.y).toBeGreaterThan(pA.y);
    // jitter intencional do stack (desarranjado) fica ≤ 0.6 do eixo
    expect(Math.abs(pA.x - origin.x)).toBeLessThanOrEqual(0.61);
    expect(Math.abs(pA.z - origin.z)).toBeLessThanOrEqual(0.51);
  });

  it('grid: página 0 mostra 16, página 1 esconde os do fim', () => {
    const pm = new PileManager();
    pm.create('base', 'c0', origin);
    for (let i = 1; i < 20; i++) pm.add('base', `c${i}`, origin);
    pm.setLayout('base', PileLayout.Grid);

    // 20 itens → 2 páginas; itens 0..15 visíveis na página 0
    expect(pm.positionOf('c0')).not.toBeNull();
    expect(pm.positionOf('c16')).toBeNull();

    expect(pm.nextPage('base')).toBe(true);
    expect(pm.positionOf('c0')).toBeNull();
    expect(pm.positionOf('c16')).not.toBeNull();
    // Volta ao início (wrap-around) após a última página
    expect(pm.nextPage('base')).toBe(true);
    expect(pm.positionOf('c0')).not.toBeNull();
  });

  it('peel gira os itens do Stack: topo vai para logo acima da base (Fase 7)', () => {
    const pm = new PileManager();
    pm.create('a', 'b', origin);
    pm.add('a', 'c', origin); // ordem: [a, b, c] — c é o topo

    // dir=1: topo (c) desce para logo acima da base → [a, c, b]
    expect(pm.peel('a', 1)).toBe(true);
    expect(pm.getState('a')!.children).toEqual(['a', 'c', 'b']);

    // dir=-1: o de baixo do topo (b) volta ao topo → [a, b, c]
    expect(pm.peel('a', -1)).toBe(true);
    expect(pm.getState('a')!.children).toEqual(['a', 'b', 'c']);
  });

  it('peel exige Stack com ≥3 itens (Grid/2 itens não gira)', () => {
    const pm = new PileManager();
    pm.create('a', 'b', origin); // só 2 itens
    expect(pm.peel('a', 1)).toBe(false);

    pm.add('a', 'c', origin);
    pm.setLayout('a', PileLayout.Grid);
    expect(pm.peel('a', 1)).toBe(false);
    expect(pm.getState('a')!.children).toEqual(['a', 'b', 'c']); // intacto
  });

  it('prevPage navega para trás com wrap-around (Fase 7)', () => {
    const pm = new PileManager();
    pm.create('base', 'c0', origin);
    for (let i = 1; i < 20; i++) pm.add('base', `c${i}`, origin);
    pm.setLayout('base', PileLayout.Grid);

    // página 0 → prev dá a última (wrap)
    expect(pm.prevPage('base')).toBe(true);
    expect(pm.getState('base')!.page).toBe(1);
    expect(pm.positionOf('c16')).not.toBeNull();

    // e volta para a 0
    expect(pm.prevPage('base')).toBe(true);
    expect(pm.getState('base')!.page).toBe(0);

    // prev em Stack não faz nada
    pm.setLayout('base', PileLayout.Stack);
    expect(pm.prevPage('base')).toBe(false);
  });

  it('toggleMessy alterna entre desarranjado (com offset x/z) e arrumado (x=0, z=0)', () => {
    const pm = new PileManager();
    pm.create('a', 'b', origin);
    pm.add('a', 'c', origin);

    // Padrão: messy = true — item c (índice 2) tem deslocamento em X e Z
    const pMessy = pm.positionOf('c')!;
    expect(pMessy.x).not.toBe(origin.x);
    expect(pMessy.z).not.toBe(origin.z);

    // Alterna p/ tidy
    expect(pm.toggleMessy('a')).toBe(true);
    const pTidy = pm.positionOf('c')!;
    expect(pTidy.x).toBe(origin.x);
    expect(pTidy.z).toBe(origin.z);

    // Alterna de volta p/ messy
    expect(pm.toggleMessy('a')).toBe(true);
    const pMessy2 = pm.positionOf('c')!;
    expect(pMessy2.x).not.toBe(origin.x);
    expect(pMessy2.z).not.toBe(origin.z);
  });

  it('serializa layout e página p/ o snapshot', () => {
    const pm = new PileManager();
    pm.create('a', 'b', origin);
    pm.setLayout('a', PileLayout.Grid);
    expect(pm.serialize()).toEqual({ a: { layout: PileLayout.Grid, page: 0 } });
  });
});
