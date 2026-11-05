/**
 * Main loop — timestep fixo de física + render condicional.
 *
 * Espelha o `EventManager::mainLoop` do original: passos de física em increments
 * fixos (alvo 60fps), render SÓ quando necessário (sleep optimization), flush
 * sujo de persistência com throttling.
 */
import type { World } from '@core/world';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5; // evita "spiral of death" se a aba travar
const SAVE_INTERVAL_MS = 2000;

export interface LoopDeps {
  world: World;
  onRender: () => void;
  onFlush?: () => void;
}

export class MainLoop {
  private running = false;
  private last = 0;
  private accum = 0;
  private lastSave = 0;
  private deps: LoopDeps;

  constructor(deps: LoopDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.25) dt = FIXED_DT; // aba ficou oculta; evita salto
    this.accum += dt;

    let steps = 0;
    while (this.accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.deps.world.update(FIXED_DT);
      this.accum -= FIXED_DT;
      steps++;
    }

    if (this.deps.world.isRenderRequired()) {
      this.deps.onRender();
      this.deps.world.markRendered();
    }

    // Flush sujo de persistência (throttled)
    if (this.deps.onFlush && now - this.lastSave > SAVE_INTERVAL_MS) {
      this.lastSave = now;
      this.deps.onFlush();
    }

    requestAnimationFrame(this.frame);
  };
}
