/**
 * Geometria pura do laço livre (P1 — Freehand Lasso).
 *
 * Algoritmos para detecção de inclusão ponto-em-polígono (Ray casting / Jordan)
 * e proximidade de traço (distância ponto a segmento de reta).
 * 100% puro: sem DOM, sem Three.js, sem dependências externas.
 */

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Testa se um ponto 2D está contido dentro de um polígono simples (não auto-interceptante).
 * Usa o algoritmo clássico de Ray Casting (Paridade de interseções).
 */
export function isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Distância ao quadrado de um ponto 2D `p` até o segmento de reta entre `v` e `w`.
 */
export function distToSegmentSq(p: Point2D, v: Point2D, w: Point2D): number {
  const dx = w.x - v.x;
  const dy = w.y - v.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) {
    const px = p.x - v.x;
    const py = p.y - v.y;
    return px * px + py * py;
  }
  let t = ((p.x - v.x) * dx + (p.y - v.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = v.x + t * dx;
  const projY = v.y + t * dy;
  const distX = p.x - projX;
  const distY = p.y - projY;
  return distX * distX + distY * distY;
}

/**
 * Calcula a caixa delimitadora (AABB) de uma sequência de pontos 2D.
 */
export function computePointsAABB(points: Point2D[]): { x: number; y: number; w: number; h: number } {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

