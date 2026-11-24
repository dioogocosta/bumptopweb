/**
 * Engine pura do minigame TRON Light Cycles (sem DOM/Three.js).
 * Controla física de movimento ortogonal contínuo, trilhas de luz,
 * detecção de colisões com paredes/jatos de luz, IA dos bots e pontuação.
 */

export type Direction = 0 | 1 | 2 | 3; // 0: Norte (-Z), 1: Leste (+X), 2: Sul (+Z), 3: Oeste (-X)
export type PlayerBikeColor = 'blue' | 'red';
export type BikeColor = 'blue' | 'red' | 'yellow' | 'orange';

export interface TrailSegment {
  id: number;
  ownerId: string;
  color: BikeColor;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface CycleState {
  id: string;
  isPlayer: boolean;
  color: BikeColor;
  x: number;
  z: number;
  dir: Direction;
  alive: boolean;
  speed: number;
  activeSegId: number;
  /** Segmento imediatamente anterior (evita autocolisão na quina da curva). */
  prevSegId: number | null;
  /** Distância percorrida no segmento atual (evita autocolisão na quina da curva). */
  segDist: number;
  /** Cooldown mínimo entre curvas do bot. */
  botCooldown: number;
}

export type GameStatus = 'playing' | 'won' | 'lost';
export type TronGameMode = 'solo' | 'local2p';
export type SplitOrientation = 'vertical' | 'horizontal';
export type TronWinner = 'p1' | 'p2' | 'draw' | null;

export interface TronEvent {
  type: 'crash' | 'turn';
  cycleId: string;
  color: BikeColor;
  x: number;
  z: number;
}

export const DIR_VEC: Record<Direction, { dx: number; dz: number }> = {
  0: { dx: 0, dz: -1 }, // Norte (-Z)
  1: { dx: 1, dz: 0 },  // Leste (+X)
  2: { dx: 0, dz: 1 },  // Sul (+Z)
  3: { dx: -1, dz: 0 }, // Oeste (-X)
};

export function turnLeft(dir: Direction): Direction {
  return ((dir + 3) % 4) as Direction;
}

export function turnRight(dir: Direction): Direction {
  return ((dir + 1) % 4) as Direction;
}

export class TronEngine {
  readonly halfSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly mode: TronGameMode;
  readonly playerColor: PlayerBikeColor;
  readonly p2Color: PlayerBikeColor;
  level: number;
  score: number;
  p1Wins = 0;
  p2Wins = 0;
  winner: TronWinner = null;
  status: GameStatus = 'playing';
  cycles: CycleState[] = [];
  segments: TrailSegment[] = [];
  private nextSegId = 1;
  private botTurnTimer = 0;

  constructor(opts: {
    halfSize?: number;
    originX?: number;
    originZ?: number;
    mode?: TronGameMode;
    playerColor: PlayerBikeColor;
    p2Color?: PlayerBikeColor;
    level?: number;
    score?: number;
  }) {
    this.halfSize = opts.halfSize ?? 85;
    this.originX = opts.originX ?? 0;
    this.originZ = opts.originZ ?? 0;
    this.mode = opts.mode ?? 'solo';
    this.playerColor = opts.playerColor;
    this.p2Color = opts.p2Color ?? (opts.playerColor === 'blue' ? 'red' : 'blue');
    this.level = opts.level ?? 1;
    this.score = opts.score ?? 0;
    this.resetRound();
  }

  resetRound(): void {
    this.cycles = [];
    this.segments = [];
    this.nextSegId = 1;
    this.status = 'playing';
    this.winner = null;
    this.botTurnTimer = 0;

    const speed = Math.min(54, 34 + (this.level - 1) * 4);
    const spawnOffset = Math.round(this.halfSize * 0.52);

    // Jogador 1 nasce ao Sul (levemente à esquerda) olhando para o Norte (-Z)
    this.spawnCycle('player', true, this.playerColor, this.originX - 18, this.originZ + spawnOffset, 0, speed);

    if (this.mode === 'local2p') {
      // Jogador 2 nasce ao Norte (levemente à direita) olhando para o Sul (+Z)
      this.spawnCycle('player2', true, this.p2Color, this.originX + 18, this.originZ - spawnOffset, 2, speed);
      return;
    }

    // Oponentes amarelos (nível 1: 1 bot; nível 2+: até 3 bots)
    const botCount = Math.min(3, this.level);
    const botSpawns: Array<{ x: number; z: number; dir: Direction; color: BikeColor }> = [
      { x: this.originX + 18, z: this.originZ - spawnOffset, dir: 2, color: 'yellow' },
      { x: this.originX - spawnOffset, z: this.originZ, dir: 1, color: 'yellow' },
      { x: this.originX + spawnOffset, z: this.originZ, dir: 3, color: 'orange' },
    ];

    for (let i = 0; i < botCount; i++) {
      const sp = botSpawns[i]!;
      this.spawnCycle(`bot-${i + 1}`, false, sp.color, sp.x, sp.z, sp.dir, speed * 0.96);
    }
  }

  private spawnCycle(
    id: string,
    isPlayer: boolean,
    color: BikeColor,
    x: number,
    z: number,
    dir: Direction,
    speed: number,
  ): void {
    const segId = this.nextSegId++;
    this.segments.push({
      id: segId,
      ownerId: id,
      color,
      x1: x,
      z1: z,
      x2: x,
      z2: z,
    });
    this.cycles.push({
      id,
      isPlayer,
      color,
      x,
      z,
      dir,
      alive: true,
      speed,
      activeSegId: segId,
      prevSegId: null,
      segDist: 0,
      botCooldown: 0.25,
    });
  }

  getPlayer(): CycleState | undefined {
    return this.cycles.find((c) => c.id === 'player');
  }

  getPlayer2(): CycleState | undefined {
    return this.cycles.find((c) => c.id === 'player2');
  }

  /** Vira a moto do jogador 1 relativa à direção atual ('left' | 'right'). */
  turnPlayer(side: 'left' | 'right'): boolean {
    return this.turnCycle(this.getPlayer(), side);
  }

  /** Vira a moto do jogador 2 relativa à direção atual ('left' | 'right'). */
  turnPlayer2(side: 'left' | 'right'): boolean {
    return this.turnCycle(this.getPlayer2(), side);
  }

  private turnCycle(cycle: CycleState | undefined, side: 'left' | 'right'): boolean {
    if (!cycle || !cycle.alive || this.status !== 'playing') return false;
    // Evita curva dupla no exato mesmo milímetro
    if (cycle.segDist < 1.2) return false;
    const nextDir = side === 'left' ? turnLeft(cycle.dir) : turnRight(cycle.dir);
    this.applyTurn(cycle, nextDir);
    return true;
  }

  private applyTurn(cycle: CycleState, nextDir: Direction): void {
    if (nextDir === cycle.dir) return;
    // Garante que não faz 180 graus
    if ((nextDir + 2) % 4 === cycle.dir) return;

    cycle.dir = nextDir;
    const newSegId = this.nextSegId++;
    this.segments.push({
      id: newSegId,
      ownerId: cycle.id,
      color: cycle.color,
      x1: cycle.x,
      z1: cycle.z,
      x2: cycle.x,
      z2: cycle.z,
    });
    cycle.prevSegId = cycle.activeSegId;
    cycle.activeSegId = newSegId;
    cycle.segDist = 0;
  }

  /** Avança a simulação por `dt` segundos e retorna eventos ocorridos neste frame. */
  step(dtRaw: number): TronEvent[] {
    if (this.status !== 'playing') return [];
    const dt = Math.min(dtRaw, 0.05);
    const events: TronEvent[] = [];

    // 1) Decisão da IA dos bots
    this.botTurnTimer += dt;
    for (const c of this.cycles) {
      if (c.isPlayer || !c.alive) continue;
      c.botCooldown = Math.max(0, c.botCooldown - dt);
      if (c.botCooldown <= 0 && c.segDist >= 2.0) {
        const nextDir = this.decideBotDirection(c);
        if (nextDir !== c.dir) {
          this.applyTurn(c, nextDir);
          c.botCooldown = 0.22;
          events.push({ type: 'turn', cycleId: c.id, color: c.color, x: c.x, z: c.z });
        }
      }
    }

    // 2) Movimento + atualização do segmento ativo
    for (const c of this.cycles) {
      if (!c.alive) continue;
      const v = DIR_VEC[c.dir];
      const dist = c.speed * dt;
      c.x += v.dx * dist;
      c.z += v.dz * dist;
      c.segDist += dist;

      const activeSeg = this.segments.find((s) => s.id === c.activeSegId);
      if (activeSeg) {
        activeSeg.x2 = c.x;
        activeSeg.z2 = c.z;
      }
    }

    // 3) Verificação de colisões (paredes e trilhas)
    const HIT_RADIUS = 1.05;
    for (const c of this.cycles) {
      if (!c.alive) continue;
      if (this.checkCollision(c, HIT_RADIUS)) {
        c.alive = false;
        events.push({ type: 'crash', cycleId: c.id, color: c.color, x: c.x, z: c.z });
        if (!c.isPlayer) {
          this.score += 500 * this.level;
        }
      }
    }

    // 4) Atualiza status da partida
    const player = this.getPlayer();
    if (this.mode === 'local2p') {
      const p2 = this.getPlayer2();
      const p1Alive = !!player?.alive;
      const p2Alive = !!p2?.alive;
      if (!p1Alive && !p2Alive) {
        this.status = 'lost';
        this.winner = 'draw';
      } else if (!p2Alive) {
        this.status = 'won';
        this.winner = 'p1';
        this.p1Wins += 1;
      } else if (!p1Alive) {
        this.status = 'won';
        this.winner = 'p2';
        this.p2Wins += 1;
      }
      return events;
    }

    const aliveBots = this.cycles.filter((c) => !c.isPlayer && c.alive).length;
    if (!player || !player.alive) {
      this.status = 'lost';
    } else if (aliveBots === 0) {
      this.status = 'won';
      this.score += 250 * this.level;
    }

    return events;
  }

  private checkCollision(c: CycleState, radius: number): boolean {
    const limit = this.halfSize - radius;
    const lx = c.x - this.originX;
    const lz = c.z - this.originZ;
    if (lx <= -limit || lx >= limit || lz <= -limit || lz >= limit) {
      return true;
    }

    // Colisão com segmentos de trilha
    for (const seg of this.segments) {
      if (seg.id === c.activeSegId) continue;
      // Ignora o segmento imediatamente anterior nos primeiros metros após a curva
      if (c.prevSegId !== null && seg.id === c.prevSegId && c.segDist < 3.5) {
        continue;
      }
      if (pointNearAxisSegment(c.x, c.z, seg, radius)) {
        return true;
      }
    }

    // Colisão cabeça-a-cabeça entre motos vivas
    for (const other of this.cycles) {
      if (other.id === c.id || !other.alive) continue;
      const dx = c.x - other.x;
      const dz = c.z - other.z;
      if (dx * dx + dz * dz < (radius * 2) ** 2) {
        return true;
      }
    }

    return false;
  }

  /** Mede a distância livre numa direção até a parede ou trilha mais próxima. */
  castRay(x: number, z: number, dir: Direction, ignoreOwnerSegId?: number): number {
    const v = DIR_VEC[dir];
    let minDist = this.halfSize * 2;

    // Distância até a parede da arena (relativa à origem da caixa)
    const maxXWall = this.originX + this.halfSize;
    const minXWall = this.originX - this.halfSize;
    const maxZWall = this.originZ + this.halfSize;
    const minZWall = this.originZ - this.halfSize;
    if (v.dx > 0) minDist = Math.min(minDist, maxXWall - x);
    else if (v.dx < 0) minDist = Math.min(minDist, x - minXWall);
    else if (v.dz > 0) minDist = Math.min(minDist, maxZWall - z);
    else if (v.dz < 0) minDist = Math.min(minDist, z - minZWall);

    const PAD = 1.25;
    for (const seg of this.segments) {
      if (seg.id === ignoreOwnerSegId) continue;
      const minX = Math.min(seg.x1, seg.x2) - PAD;
      const maxX = Math.max(seg.x1, seg.x2) + PAD;
      const minZ = Math.min(seg.z1, seg.z2) - PAD;
      const maxZ = Math.max(seg.z1, seg.z2) + PAD;

      if (v.dx > 0 && z >= minZ && z <= maxZ && minX > x) {
        minDist = Math.min(minDist, minX - x);
      } else if (v.dx < 0 && z >= minZ && z <= maxZ && maxX < x) {
        minDist = Math.min(minDist, x - maxX);
      } else if (v.dz > 0 && x >= minX && x <= maxX && minZ > z) {
        minDist = Math.min(minDist, minZ - z);
      } else if (v.dz < 0 && x >= minX && x <= maxX && maxZ < z) {
        minDist = Math.min(minDist, z - maxZ);
      }
    }

    return Math.max(0, minDist);
  }

  private decideBotDirection(bot: CycleState): Direction {
    const straight = bot.dir;
    const left = turnLeft(bot.dir);
    const right = turnRight(bot.dir);

    const dStraight = this.castRay(bot.x, bot.z, straight, bot.activeSegId);
    const dLeft = this.castRay(bot.x, bot.z, left, bot.activeSegId);
    const dRight = this.castRay(bot.x, bot.z, right, bot.activeSegId);

    const panicDist = 14 + bot.speed * 0.25;

    // Se há risco à frente, escolhe o lado com mais espaço
    if (dStraight < panicDist) {
      if (dLeft >= dRight && dLeft > dStraight) return left;
      if (dRight > dLeft && dRight > dStraight) return right;
      return dLeft >= dRight ? left : right;
    }

    // Comportamento tático ocasional: se tiver bastante espaço na perpendicular e o jogador
    // estiver nessa direção, pode virar para tentar fechar o caminho
    const player = this.getPlayer();
    if (player && player.alive && dStraight > 22 && bot.segDist > 18) {
      const dx = player.x - bot.x;
      const dz = player.z - bot.z;
      const distToPlayer = Math.hypot(dx, dz);
      if (distToPlayer < 45) {
        const lVec = DIR_VEC[left];
        const rVec = DIR_VEC[right];
        const lDot = dx * lVec.dx + dz * lVec.dz;
        const rDot = dx * rVec.dx + dz * rVec.dz;
        if (lDot > 8 && dLeft > 26 && (Math.floor(this.botTurnTimer * 10) % 7 === 0)) {
          return left;
        }
        if (rDot > 8 && dRight > 26 && (Math.floor(this.botTurnTimer * 10) % 9 === 0)) {
          return right;
        }
      }
    }

    return straight;
  }
}

function pointNearAxisSegment(px: number, pz: number, seg: TrailSegment, radius: number): boolean {
  const minX = Math.min(seg.x1, seg.x2) - radius;
  const maxX = Math.max(seg.x1, seg.x2) + radius;
  const minZ = Math.min(seg.z1, seg.z2) - radius;
  const maxZ = Math.max(seg.z1, seg.z2) + radius;
  return px >= minX && px <= maxX && pz >= minZ && pz <= maxZ;
}
