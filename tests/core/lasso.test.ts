import { describe, it, expect } from 'vitest';
import {
  computePointsAABB,
  distToSegmentSq,
  isPointInPolygon,
} from '../../src/core/selection/lassoGeometry';

describe('lassoGeometry (P1 — Freehand Lasso)', () => {
  describe('isPointInPolygon', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];

    it('detecta ponto no centro do quadrado', () => {
      expect(isPointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    });

    it('detecta ponto fora do quadrado', () => {
      expect(isPointInPolygon({ x: -10, y: 50 }, square)).toBe(false);
      expect(isPointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
      expect(isPointInPolygon({ x: 50, y: 150 }, square)).toBe(false);
    });

    it('retorna false para polígono com menos de 3 vértices', () => {
      expect(isPointInPolygon({ x: 10, y: 10 }, [{ x: 0, y: 0 }, { x: 20, y: 20 }])).toBe(false);
    });

    it('funciona para polígono côncavo em U', () => {
      const uShape = [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 20 },
        { x: 20, y: 20 },
        { x: 20, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 20 },
        { x: 0, y: 20 },
      ];
      // Ponto na "cavidade" do U está fora
      expect(isPointInPolygon({ x: 15, y: 15 }, uShape)).toBe(false);
      // Ponto na haste esquerda do U está dentro
      expect(isPointInPolygon({ x: 5, y: 10 }, uShape)).toBe(true);
    });
  });

  describe('distToSegmentSq', () => {
    const v = { x: 0, y: 0 };
    const w = { x: 100, y: 0 };

    it('distância perpendicular a uma linha horizontal', () => {
      expect(distToSegmentSq({ x: 50, y: 10 }, v, w)).toBe(100); // 10^2
    });

    it('ponto além das extremidades projeta no vértice mais próximo', () => {
      expect(distToSegmentSq({ x: -10, y: 0 }, v, w)).toBe(100); // 10^2 do ponto v
      expect(distToSegmentSq({ x: 110, y: 0 }, v, w)).toBe(100); // 10^2 do ponto w
    });

    it('ponto no próprio segmento tem distância zero', () => {
      expect(distToSegmentSq({ x: 50, y: 0 }, v, w)).toBe(0);
    });
  });

  describe('computePointsAABB', () => {
    it('calcula AABB correto de múltiplos pontos', () => {
      const pts = [
        { x: 10, y: 20 },
        { x: 50, y: 5 },
        { x: -5, y: 80 },
      ];
      const aabb = computePointsAABB(pts);
      expect(aabb).toEqual({
        x: -5,
        y: 5,
        w: 55,
        h: 75,
      });
    });

    it('retorna dimensões mínimas para lista vazia ou 1 ponto', () => {
      expect(computePointsAABB([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
      expect(computePointsAABB([{ x: 10, y: 10 }])).toEqual({ x: 10, y: 10, w: 1, h: 1 });
    });
  });
});

