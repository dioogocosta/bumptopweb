/**
 * Adapter de input — Pointer Events → AÇÕES SEMÂNTICAS.
 *
 * Unifica desktop (mouse) e mobile (toque) numa única máquina. O `core` nunca
 * vê eventos crus — só ações (`Select`, `Drag`, `Zoom`, `Pan`, `Context`...).
 *
 * O caller injeta um `resolve` que projeta um ponto de tela → ponto de mundo
 * (plano do piso). Assim este adapter continua puro de DOM e não conhece three.js.
 */
import type { IInput, InputAction } from '@core/ports/index';

export type ScreenResolver = (screen: { x: number; y: number }) => { x: number; y: number; z: number };

interface ActivePointer {
  x: number;
  y: number;
}

const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 300;

export class PointerInput implements IInput {
  private target: HTMLElement | null = null;
  private cb: ((a: InputAction) => void) | null = null;
  private resolve: ScreenResolver;
  private pointers = new Map<number, ActivePointer>();
  private isDragging = false;
  private longPressTimer: number | null = null;
  private lastTapTime = 0;
  private pinchDist = 0;
  /** Órbita ativa (botão direito/meio). Guarda o último ponto do arraste. */
  private orbiting = false;
  private orbitPrev: { x: number; y: number } | null = null;
  /** O arraste de botão direito se moveu (≠ clique). */
  private orbitMoved = false;
  /** Próximo `contextmenu` foi pós-órbita → suprime. */
  private suppressContext = false;
  /** Timestamp do último pointerMove p/ calcular speed (px/s). */
  private lastMoveTime = 0;

  constructor(resolve: ScreenResolver) {
    this.resolve = resolve;
  }

  attach(target: HTMLElement): void {
    this.target = target;
    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerup', this.onUp);
    target.addEventListener('pointercancel', this.onCancel);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', this.onContextMenu);
  }

  setListener(cb: (action: InputAction) => void): void {
    this.cb = cb;
  }

  private emit(a: InputAction): void {
    this.cb?.(a);
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.target!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.target) return;
    // try/catch: eventos sintéticos (testes) ou ponteiros já soltos lançam
    // NotFoundError — não deve abortar o resto do handler.
    try {
      this.target.setPointerCapture(e.pointerId);
    } catch {
      /* captura opcional */
    }
    const s = this.local(e);
    this.pointers.set(e.pointerId, s);

    // 3+ dedos → scrunch (C): intercepta ANTES de long-press/drag
    if (this.pointers.size >= 3) {
      this.isDragging = false;
      this.clearLongPress();
      const pts = [...this.pointers.values()];
      const centroid = { x: pts.reduce((a, b) => a + b.x, 0) / pts.length, y: pts.reduce((a, b) => a + b.y, 0) / pts.length };
      const world = this.resolve(centroid);
      this.emit({ type: 'scrunch', world, screen: centroid });
      return;
    }

    // Dois dedos → início de pinch/pan (mobile)
    if (this.pointers.size === 2) {
      this.isDragging = false;
      this.clearLongPress();
      this.pinchDist = this.currentPinchDist();
      return;
    }

    if (e.button === 0) {
      this.isDragging = true;
      const world = this.resolve(s);
      this.emit({
        type: 'pointerDown',
        world,
        screen: s,
        button: 0,
        pointerId: e.pointerId,
        pointerType: (e.pointerType || 'mouse') as 'mouse' | 'touch' | 'pen',
        shift: e.shiftKey,
      });
      // Long-press (toque) → contexto
      if (e.pointerType === 'touch') {
        this.longPressTimer = window.setTimeout(() => {
          if (this.isDragging) {
            this.isDragging = false;
            this.emit({ type: 'longPress', world: this.resolve(s), pointerId: e.pointerId });
            this.emit({ type: 'context', world: this.resolve(s), screen: s });
          }
        }, LONG_PRESS_MS);
      }
    } else if (e.button === 1 || e.button === 2) {
      // Botão meio/direito → órbita da câmera
      this.orbiting = true;
      this.orbitPrev = s;
      this.orbitMoved = false;
      this.suppressContext = false;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.target) return;
    const s = this.local(e);

    // Hover quando nenhum botão/toque está ativo (mouse/caneta sem contato)
    if (this.pointers.size === 0 && !this.isDragging && !this.orbiting && (e.buttons === 0 || e.buttons === undefined)) {
      const world = this.resolve(s);
      this.emit({ type: 'hover', world, screen: s });
      return;
    }

    const prev = this.pointers.get(e.pointerId);
    this.pointers.set(e.pointerId, s);

    // Scrunch (3+ dedos): detecta ≥3 ponteiros no chão (C)
    if (this.pointers.size >= 3) {
      const pts = [...this.pointers.values()];
      const centroid = { x: pts.reduce((a, b) => a + b.x, 0) / pts.length, y: pts.reduce((a, b) => a + b.y, 0) / pts.length };
      const world = this.resolve(centroid);
      this.emit({ type: 'scrunch', world, screen: centroid });
      return;
    }

    // Pinch-zoom / órbita com 2 dedos
    if (this.pointers.size === 2) {
      const dist = this.currentPinchDist();
      if (this.pinchDist > 0) {
        const delta = (this.pinchDist - dist) * 2; // negativo = afastar = zoom in
        const pts = [...this.pointers.values()];
        const centroid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const world = this.resolve(centroid);
        this.emit({ type: 'zoom', delta, world, screen: centroid, pinch: true });
      }
      this.pinchDist = dist;
      // Arrastar com 2 dedos → órbita (não pan) — gesto clássico do BumpTop
      const pts = [...this.pointers.values()];
      const centroid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (this.orbitPrev) {
        const dx = centroid.x - this.orbitPrev.x;
        const dy = centroid.y - this.orbitPrev.y;
        this.emit({ type: 'orbit', dAzimuth: -dx * 0.008, dElevation: dy * 0.008 });
      }
      this.orbitPrev = centroid;
      return;
    }
    if (this.pointers.size === 1 && !this.orbiting) this.orbitPrev = null;

    // Arraste com botão direito/meio → órbita contínua
    if (this.orbiting && this.orbitPrev) {
      const dx = s.x - this.orbitPrev.x;
      const dy = s.y - this.orbitPrev.y;
      this.orbitPrev = s;
      if (dx !== 0 || dy !== 0) this.orbitMoved = true;
      this.emit({ type: 'orbit', dAzimuth: -dx * 0.008, dElevation: dy * 0.008 });
      return;
    }

    if (this.isDragging) {
      // Movimento real cancela o long-press
      if (prev && (Math.abs(s.x - prev.x) > 4 || Math.abs(s.y - prev.y) > 4)) this.clearLongPress();
      const world = this.resolve(s);
      // Speed em px/s p/ flick (C)
      const now = performance.now();
      const dt = prev ? (now - (this.lastMoveTime ?? now)) / 1000 : 0;
      this.lastMoveTime = now;
      const speed = prev && dt > 0 ? Math.hypot(s.x - prev.x, s.y - prev.y) / dt : 0;
      this.emit({ type: 'pointerMove', world, screen: s, pointerId: e.pointerId, speed });
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.target) return;
    this.target.releasePointerCapture?.(e.pointerId);
    const s = this.local(e);
    this.pointers.delete(e.pointerId);
    this.clearLongPress();

    if (this.pointers.size < 2) this.pinchDist = 0;

    if (this.orbiting && this.pointers.size === 0) {
      this.orbiting = false;
      // Arrastou = órbita, não um "clique com botão direito" (não abre menu)
      if (this.orbitMoved) this.suppressContext = true;
      this.orbitPrev = null;
      this.orbitMoved = false;
    }

    if (this.isDragging) {
      this.isDragging = false;
      const world = this.resolve(s);
      this.emit({ type: 'pointerUp', world, screen: s, pointerId: e.pointerId });

      // Tap (toque) / duplo-clique
      if (e.pointerType === 'touch') {
        const now = performance.now();
        if (now - this.lastTapTime < DOUBLE_TAP_MS) {
          this.emit({ type: 'doubleTap', world, pointerId: e.pointerId });
          this.lastTapTime = 0;
        } else {
          this.emit({ type: 'tap', world, pointerId: e.pointerId });
          this.lastTapTime = now;
        }
      }
    }
  };

  private onCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    this.isDragging = false;
    this.orbiting = false;
    this.orbitPrev = null;
    this.emit({ type: 'cancel', pointerId: e.pointerId });
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.target) return;
    // Passa o ponto do cursor: scroll sobre uma pilha navega a pilha em vez
    // de dar zoom na câmera (Fase 7 — scroll-over-pile).
    const r = this.target.getBoundingClientRect();
    const s = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.emit({ type: 'zoom', delta: e.deltaY, world: this.resolve(s), screen: s });
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!this.target) return;
    // O botão direito foi usado para ORBITAR (arrastou) → não abre menu
    if (this.suppressContext) {
      this.suppressContext = false;
      return;
    }
    const r = this.target.getBoundingClientRect();
    const s = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.emit({ type: 'context', world: this.resolve(s), screen: s });
  };

  private currentPinchDist(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  detach(): void {
    if (!this.target) return;
    this.target.removeEventListener('pointerdown', this.onDown);
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerup', this.onUp);
    this.target.removeEventListener('pointercancel', this.onCancel);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
    this.clearLongPress();
    this.target = null;
  }
}
