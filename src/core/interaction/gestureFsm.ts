/**
 * FSM de gestos — espelha `BT_GestureManager` + `BT_CommonFiniteStates`.
 *
 * Consome eventos de ponteiro JÁ normalizados (coordenadas de mundo + tela)
 * e classifica a intenção: Tap, DoubleTap, LongPress, Drag, Flick (toss),
 * Shove (arrastar o "chão" empurrando objetos) e Camera (órbita/zoom).
 *
 * Puro: sem DOM — o adapter de input entrega os fatos, este FSM decide.
 */

export type GestureEvent =
  | { type: 'tap'; at: GesturePoint }
  | { type: 'doubleTap'; at: GesturePoint }
  | { type: 'longPress'; at: GesturePoint }
  | { type: 'dragStart'; at: GesturePoint; target: GestureTarget }
  | { type: 'dragMove'; at: GesturePoint }
  | { type: 'dragEnd'; at: GesturePoint; velocity: { x: number; y: number }; flick: boolean }
  | { type: 'shoveMove'; at: GesturePoint }
  | { type: 'shoveEnd' }
  | { type: 'cancel' };

export interface GesturePoint {
  x: number;
  y: number; // piso (mundo) — y útil p/ projeções
  screenX: number;
  screenY: number;
}

export type GestureTarget = 'object' | 'floor' | 'wall';

export type GestureState =
  | 'idle'
  | 'pressed'
  | 'dragging'
  | 'shoving'
  | 'orbiting';

export interface GestureConfig {
  /** Distância (px) que separa tap de drag. */
  slopPx: number;
  /** ms p/ long-press. */
  longPressMs: number;
  /** ms p/ duplo-tap. */
  doubleTapMs: number;
  /** Velocidade² mínima (px/s) p/ classificar Flick. */
  flickVelocitySq: number;
}

export const DEFAULT_GESTURE: GestureConfig = {
  slopPx: 8,
  longPressMs: 500,
  doubleTapMs: 300,
  flickVelocitySq: 2500 * 2500, // 2500 px/s
};

type Listener = (ev: GestureEvent) => void;

/**
 * Máquina de estados. Uso típico (adapter de input):
 *   fsm.press(p, 'object'); ... fsm.move(p); ... fsm.release(p);
 * O chamador decide quando chamar `tick(now)` p/ long-press.
 */
export class GestureFSM {
  private state: GestureState = 'idle';
  private cfg: GestureConfig;
  private listeners: Listener[] = [];

  private pressPt: GesturePoint | null = null;
  private lastPt: GesturePoint | null = null;
  private lastTime = 0;
  private lastTapTime = Number.NEGATIVE_INFINITY;
  private target: GestureTarget = 'floor';
  private movedBeyondSlop = false;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE, ...cfg };
  }

  getState(): GestureState {
    return this.state;
  }

  on(l: Listener): void {
    this.listeners.push(l);
  }

  private emit(ev: GestureEvent): void {
    for (const l of this.listeners) l(ev);
  }

  /** Pressionou. `target` diz o que foi atingido (objeto/chão/parede). */
  press(p: GesturePoint, target: GestureTarget, now: number): void {
    if (this.state !== 'idle') return;
    this.pressPt = p;
    this.lastPt = p;
    this.lastTime = now;
    this.target = target;
    this.movedBeyondSlop = false;
    this.state = 'pressed';

    // Long-press armado (só p/ toque; o adapter decide ao chamar)
    this.clearLongPress();
    this.longPressTimer = setTimeout(() => {
      if (this.state === 'pressed' && !this.movedBeyondSlop && this.pressPt) {
        this.emit({ type: 'longPress', at: this.pressPt });
        this.reset('idle');
      }
    }, this.cfg.longPressMs);
  }

  /** Movimento do ponteiro. */
  move(p: GesturePoint, now: number): void {
    if (this.state === 'idle' || !this.pressPt) return;
    const dx = p.screenX - this.pressPt.screenX;
    const dy = p.screenY - this.pressPt.screenY;
    const dist = Math.hypot(dx, dy);

    if (this.state === 'pressed') {
      if (dist < this.cfg.slopPx) return;
      // Ultrapassou o slop → virou arraste (ou shove, se no chão)
      this.movedBeyondSlop = true;
      this.clearLongPress();
      this.lastPt = p;
      this.lastTime = now;
      if (this.target === 'object') {
        this.state = 'dragging';
        this.emit({ type: 'dragStart', at: this.pressPt, target: this.target });
      } else {
        this.state = 'shoving';
        this.emit({ type: 'dragStart', at: this.pressPt, target: 'floor' });
      }
      return; // o movimento de transição NÃO gera dragMove extra
    }

    if (this.state === 'dragging') this.emit({ type: 'dragMove', at: p });
    else if (this.state === 'shoving') this.emit({ type: 'shoveMove', at: p });

    this.lastPt = p;
    this.lastTime = now;
  }

  /** Soltou. Classifica tap / double-tap / flick / fim de arraste. */
  release(p: GesturePoint, now: number): void {
    if (this.state === 'idle' || !this.pressPt) return;
    this.clearLongPress();

    if (this.state === 'pressed' && !this.movedBeyondSlop) {
      // Tap (ou double-tap)
      if (now - this.lastTapTime < this.cfg.doubleTapMs) {
        this.emit({ type: 'doubleTap', at: p });
        this.lastTapTime = Number.NEGATIVE_INFINITY;
      } else {
        this.emit({ type: 'tap', at: p });
        this.lastTapTime = now;
      }
      this.reset('idle');
      return;
    }

    if (this.state === 'dragging') {
      // Velocidade do último segmento
      const dt = Math.max(1, now - this.lastTime) / 1000;
      const vx = this.lastPt ? (p.screenX - this.lastPt.screenX) / dt : 0;
      const vy = this.lastPt ? (p.screenY - this.lastPt.screenY) / dt : 0;
      const flick = vx * vx + vy * vy >= this.cfg.flickVelocitySq;
      this.emit({ type: 'dragEnd', at: p, velocity: { x: vx, y: vy }, flick });
      this.reset('idle');
      return;
    }

    if (this.state === 'shoving') {
      this.emit({ type: 'shoveEnd' });
      this.reset('idle');
      return;
    }

    this.cancel();
  }

  /** Cancela (pointercancel/ESC): volta ao repouso sem eventos finais. */
  cancel(): void {
    if (this.state === 'idle') return;
    this.emit({ type: 'cancel' });
    this.reset('idle');
  }

  private reset(s: GestureState): void {
    this.state = s;
    this.pressPt = null;
    this.lastPt = null;
    this.movedBeyondSlop = false;
    this.clearLongPress();
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  dispose(): void {
    this.clearLongPress();
    this.listeners.length = 0;
  }
}
