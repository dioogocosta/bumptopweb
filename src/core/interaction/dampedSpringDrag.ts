/**
 * Controlador de arraste por MOLA AMORTECIDA — a mecânica assinatura do BumpTop.
 *
 * Espelha `DampedSpringMouseHandler` (port Mac): o objeto NÃO gruda no mouse.
 * Ele persegue o alvo (ponto de mundo sob o cursor) com uma mola, o que cria
 * a sensação de "peso". Essa inércia é exatamente o que permite o TOSS: ao
 * soltar com velocidade, o objeto voa como projétil.
 *
 * Modelo (semi-implicit Euler, crítico-amortecido p/ sem overshoot):
 *   força  = k * (alvo - pos) - c * vel
 *   vel   += força * dt
 *   pos   += vel * dt
 *
 * Tudo puro — testável sem DOM/WebGL.
 */

import type { Vec3 } from '../model/types';
import { lengthSq, sub, add, scale, vec3 } from '../util/math';

export interface SpringConfig {
  /** Rigidez da mola (maior = segue mais "colado"). */
  stiffness: number;
  /** Amortecimento (maior = menos oscilação). */
  damping: number;
  /** Limiar de velocidade² para iniciar o toss ao soltar. */
  minTossVelocitySq: number;
}

/**
 * Valores sintonizados para a escala do original (sala ~130, toss |v|≥100).
 * Stiffness p/ seguir o cursor com lag perceptível; o fling rápido atinge |v|²≥10000.
 * FINE-TUNING requer calibração manual (ver README — "peso" do BumpTop).
 */
export const DEFAULT_SPRING: SpringConfig = {
  stiffness: 220,
  damping: 20,
  minTossVelocitySq: 10000, // MinStartTossVelocitySq (BT_Settings.cpp:53)
};

export class DampedSpringDrag {
  private pos: Vec3 = vec3();
  private vel: Vec3 = vec3();
  private target: Vec3 = vec3();
  private dragging = false;
  private cfg: SpringConfig;

  constructor(cfg: SpringConfig = DEFAULT_SPRING) {
    this.cfg = cfg;
  }

  /** Começa o arraste a partir da posição atual do objeto. */
  begin(currentPos: Vec3, target: Vec3): void {
    this.pos = { ...currentPos };
    this.vel = vec3();
    this.target = { ...target };
    this.dragging = true;
  }

  /** Atualiza o alvo (posição de mundo sob o cursor). */
  setTarget(target: Vec3): void {
    this.target = { ...target };
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** Avança a simulação da mola. Retorna a nova posição. */
  step(dt: number): Vec3 {
    if (!this.dragging) return this.pos;
    const springForce = scale(sub(this.target, this.pos), this.cfg.stiffness);
    const dampForce = scale(this.vel, -this.cfg.damping);
    const accel = add(springForce, dampForce);
    this.vel = add(this.vel, scale(accel, dt));
    this.pos = add(this.pos, scale(this.vel, dt));
    return this.pos;
  }

  /**
   * Solta o arraste. Retorna a velocidade de lançamento.
   * Se |v|² ≥ minTossVelocitySq, o chamador deve ativar o TOSS.
   */
  end(): { velocity: Vec3; toss: boolean } {
    this.dragging = false;
    const velocity = { ...this.vel };
    const toss = lengthSq(velocity) >= this.cfg.minTossVelocitySq;
    this.vel = vec3();
    return { velocity, toss };
  }

  /** Cancela o arraste (ESC / pointercancel): sem toss, volta a repousar. */
  cancel(): void {
    this.dragging = false;
    this.vel = vec3();
  }

  getVelocity(): Vec3 {
    return { ...this.vel };
  }

  setConfig(cfg: Partial<SpringConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }
}
