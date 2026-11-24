import * as THREE from 'three';
import {
  DIR_VEC,
  TronEngine,
  type BikeColor,
  type CycleState,
  type PlayerBikeColor,
  type SplitOrientation,
  type TrailSegment,
  type TronGameMode,
} from './tronEngine';
import type { ThreeRenderer } from '@render/three/threeRenderer';
import type { World } from '@core/world';
import type { SceneSnapshot } from '@core/model/types';
import { t } from '@core/i18n/i18n';
import { renderTronRankingBox, type TronRankingResponse } from './tronRanking';

const COLOR_HEX: Record<BikeColor, number> = {
  blue: 0x00d2ff,
  red: 0xff2a55,
  yellow: 0xfacc15,
  orange: 0xf97316,
};

const COLOR_CSS: Record<BikeColor, string> = {
  blue: '#00d2ff',
  red: '#ff2a55',
  yellow: '#facc15',
  orange: '#f97316',
};

interface Shard {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

interface CycleVisual {
  group: THREE.Group;
  yaw: number;
  bank: number;
}

export interface TronGameHost {
  parent: HTMLElement;
  renderer: ThreeRenderer;
  world: World;
  playerColor: PlayerBikeColor;
  mode?: TronGameMode;
  splitOrientation?: SplitOrientation;
  boxId: string;
  onExit: () => void;
  rankingOpts?: {
    isLoggedIn: boolean;
    onScoreSubmit?: (score: number, level: number) => Promise<TronRankingResponse | null>;
  };
}

export class TronGameView {
  private container: HTMLDivElement;
  private renderer: ThreeRenderer;
  private world: World;
  private boxId: string;
  private preGameSnapshot: SceneSnapshot;

  private gameGroup = new THREE.Group();
  private engine: TronEngine;

  private cycleVisuals = new Map<string, CycleVisual>();
  private trailMeshes = new Map<number, THREE.Mesh>();
  private shards: Shard[] = [];
  private trailMatCache = new Map<BikeColor, THREE.MeshStandardMaterial>();

  private scoreEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private botsEl!: HTMLElement;
  private statusOverlay!: HTMLDivElement;
  private statusTitleEl!: HTMLElement;
  private statusSubEl!: HTMLElement;
  private statusRankingEl!: HTMLDivElement;
  private nextBtn!: HTMLButtonElement;
  private minimapCanvas!: HTMLCanvasElement;
  private rankingOpts?: TronGameHost['rankingOpts'];
  private maxLevelReached = 1;

  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private cam2Pos = new THREE.Vector3();
  private cam2Look = new THREE.Vector3();
  private splitOrientation: SplitOrientation;
  private p1BadgeEl?: HTMLElement;
  private p2BadgeEl?: HTMLElement;
  private raf = 0;
  private lastTs = 0;
  private frameCount = 0;
  private disposed = false;
  private onExitCb: (() => void) | null = null;
  private onKeyDownBound: (e: KeyboardEvent) => void;

  constructor(host: TronGameHost) {
    this.renderer = host.renderer;
    this.world = host.world;
    this.boxId = host.boxId;
    this.onExitCb = host.onExit;
    this.rankingOpts = host.rankingOpts;
    this.splitOrientation = host.splitOrientation ?? 'vertical';

    // Salva o snapshot pré-jogo para restaurar os papéis/itens ao sair
    this.preGameSnapshot = this.world.toSnapshot();

    const box = this.world.getBox(this.boxId);
    const originX = box?.pos.x ?? 0;
    const originZ = box?.pos.z ?? 0;
    const halfSize = Math.max(40, (box?.halfSize ?? 130) - 4);

    this.engine = new TronEngine({
      halfSize,
      originX,
      originZ,
      mode: host.mode ?? 'solo',
      playerColor: host.playerColor,
      level: 1,
    });

    // Container transparente de HUD sobre o canvas principal do BumpTop
    this.container = document.createElement('div');
    this.container.className = 'tron-game-container';

    this.buildArenaOverlay(originX, originZ, halfSize);
    this.renderer.getScene().add(this.gameGroup);

    this.buildHud();
    this.syncVisualsFromEngine();
    this.snapCameraToPlayer();

    host.parent.appendChild(this.container);

    this.onKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);
    window.addEventListener('keydown', this.onKeyDownBound);

    this.lastTs = performance.now();
    this.playSynthTone(440, 0.12, 'sawtooth');
    this.loop(this.lastTs);
  }

  /** Adiciona grade neon e borda luminosa sobre o piso/paredes reais da caixa BumpTop. */
  private buildArenaOverlay(ox: number, oz: number, hs: number): void {
    const size = hs * 2;

    const gridMain = new THREE.GridHelper(size, 32, 0x9333ea, 0x4c1d95);
    gridMain.position.set(ox, 0.08, oz);
    const mats = Array.isArray(gridMain.material) ? gridMain.material : [gridMain.material];
    for (const m of mats) {
      m.transparent = true;
      m.opacity = 0.55;
    }
    this.gameGroup.add(gridMain);

    // Moldura neon nas bordas da sala
    const borderGeo = new THREE.BoxGeometry(size, 5.5, size);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(borderGeo),
      new THREE.LineBasicMaterial({ color: 0x00d2ff, transparent: true, opacity: 0.75 }),
    );
    edges.position.set(ox, 2.75, oz);
    this.gameGroup.add(edges);
  }

  private createLightCycleMesh(color: BikeColor): THREE.Group {
    const hex = COLOR_HEX[color];
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.25,
      metalness: 0.8,
    });
    const neonMat = new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: 1.7,
      roughness: 0.2,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      emissive: hex,
      emissiveIntensity: 0.4,
      roughness: 0.1,
      metalness: 0.9,
    });

    // Chassi aerodinâmico principal (frente aponta para -Z)
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.85, 3.8), bodyMat);
    chassis.position.set(0, 0.92, 0);
    group.add(chassis);

    // Carenagem/visor superior neon
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.56, 2.15), glassMat);
    canopy.position.set(0, 1.48, -0.18);
    group.add(canopy);

    // Faixa central luminosa no topo
    const topStrip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 3.4), neonMat);
    topStrip.position.set(0, 1.78, -0.05);
    group.add(topStrip);

    // Rodas de luz dianteira e traseira
    const wheelGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.56, 20);
    wheelGeo.rotateZ(Math.PI / 2);

    const frontWheel = new THREE.Mesh(wheelGeo, neonMat);
    frontWheel.position.set(0, 0.75, -1.6);
    group.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelGeo, neonMat);
    rearWheel.position.set(0, 0.75, 1.6);
    group.add(rearWheel);

    // Laterais luminosas
    const sideGeo = new THREE.BoxGeometry(0.1, 0.3, 2.7);
    const leftSide = new THREE.Mesh(sideGeo, neonMat);
    leftSide.position.set(-0.6, 0.9, 0);
    const rightSide = new THREE.Mesh(sideGeo, neonMat);
    rightSide.position.set(0.6, 0.9, 0);
    group.add(leftSide, rightSide);

    // Luz neon dinâmica sob a moto
    const glow = new THREE.PointLight(hex, 2.2, 28);
    glow.position.set(0, 2.4, 0);
    group.add(glow);

    return group;
  }

  private getTrailMaterial(color: BikeColor): THREE.MeshStandardMaterial {
    let mat = this.trailMatCache.get(color);
    if (!mat) {
      const hex = COLOR_HEX[color];
      mat = new THREE.MeshStandardMaterial({
        color: hex,
        emissive: hex,
        emissiveIntensity: 1.35,
        transparent: true,
        opacity: 0.86,
        roughness: 0.2,
      });
      this.trailMatCache.set(color, mat);
    }
    return mat;
  }

  private buildHud(): void {
    const topLeft = document.createElement('div');
    topLeft.className = 'tron-hud-tl';

    this.levelEl = document.createElement('div');
    this.levelEl.className = 'tron-level-badge';

    this.botsEl = document.createElement('div');
    this.botsEl.className = 'tron-bots-badge';

    const hintEl = document.createElement('div');
    hintEl.className = 'tron-controls-hint';
    hintEl.textContent = t('ui.tron.controlsHint');

    topLeft.append(this.levelEl, this.botsEl, hintEl);
    this.container.appendChild(topLeft);

    const topRight = document.createElement('div');
    topRight.className = 'tron-hud-tr';

    this.minimapCanvas = document.createElement('canvas');
    this.minimapCanvas.width = 124;
    this.minimapCanvas.height = 124;
    this.minimapCanvas.className = 'tron-minimap';

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'tron-exit-btn';
    exitBtn.textContent = `✕ ${t('ui.tron.exit')}`;
    exitBtn.addEventListener('click', () => this.exit());

    topRight.append(exitBtn, this.minimapCanvas);
    this.container.appendChild(topRight);

    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'tron-score';
    this.scoreEl.textContent = 'SCORE : 0';
    this.container.appendChild(this.scoreEl);

    if (this.engine.mode === 'local2p') {
      const divider = document.createElement('div');
      divider.className = `tron-split-divider ${this.splitOrientation}`;
      this.container.appendChild(divider);

      this.p1BadgeEl = document.createElement('div');
      this.p1BadgeEl.className = `tron-p-badge p1 ${this.splitOrientation}`;
      this.container.appendChild(this.p1BadgeEl);

      this.p2BadgeEl = document.createElement('div');
      this.p2BadgeEl.className = `tron-p-badge p2 ${this.splitOrientation}`;
      this.container.appendChild(this.p2BadgeEl);
    }

    const touchWrap = document.createElement('div');
    touchWrap.className = 'tron-touch-controls';
    if (this.engine.mode === 'local2p') {
      touchWrap.style.display = 'none';
    }
    const leftBtn = document.createElement('button');
    leftBtn.type = 'button';
    leftBtn.className = 'tron-touch-btn';
    leftBtn.textContent = '◀';
    leftBtn.setAttribute('aria-label', 'Virar à esquerda');
    leftBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.turn('left');
    });

    const rightBtn = document.createElement('button');
    rightBtn.type = 'button';
    rightBtn.className = 'tron-touch-btn';
    rightBtn.textContent = '▶';
    rightBtn.setAttribute('aria-label', 'Virar à direita');
    rightBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.turn('right');
    });

    touchWrap.append(leftBtn, rightBtn);
    this.container.appendChild(touchWrap);

    this.statusOverlay = document.createElement('div');
    this.statusOverlay.className = 'tron-status-overlay';
    this.statusOverlay.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'tron-status-card';

    this.statusTitleEl = document.createElement('h2');
    this.statusTitleEl.className = 'tron-status-title';

    this.statusSubEl = document.createElement('p');
    this.statusSubEl.className = 'tron-status-sub';

    this.statusRankingEl = document.createElement('div');
    this.statusRankingEl.className = 'tron-ranking-box';
    this.statusRankingEl.style.display = 'none';

    const btnRow = document.createElement('div');
    btnRow.className = 'tron-status-actions';

    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'tron-btn-primary';
    this.nextBtn.addEventListener('click', () => this.advanceOrRetry());

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'tron-btn-secondary';
    backBtn.textContent = t('ui.tron.exit');
    backBtn.addEventListener('click', () => this.exit());

    btnRow.append(this.nextBtn, backBtn);
    card.append(this.statusTitleEl, this.statusSubEl, this.statusRankingEl, btnRow);
    this.statusOverlay.appendChild(card);
    this.container.appendChild(this.statusOverlay);

    this.updateHud();
  }

  private turn(side: 'left' | 'right', target: 'p1' | 'p2' = 'p1'): void {
    const ok = target === 'p2' ? this.engine.turnPlayer2(side) : this.engine.turnPlayer(side);
    if (ok) {
      this.playSynthTone(target === 'p2' ? 540 : 620, 0.05, 'square');
      const cycle = target === 'p2' ? this.engine.getPlayer2() : this.engine.getPlayer();
      const vis = cycle ? this.cycleVisuals.get(cycle.id) : undefined;
      if (vis) {
        vis.bank = side === 'left' ? 0.36 : -0.36;
      }
    }
  }

  private advanceOrRetry(): void {
    if (this.engine.mode === 'solo') {
      if (this.engine.status === 'won') {
        this.engine.level += 1;
        this.maxLevelReached = Math.max(this.maxLevelReached, this.engine.level);
      } else {
        this.engine.level = 1;
        this.engine.score = 0;
      }
    }
    this.clearArenaVisuals();
    this.engine.resetRound();
    this.syncVisualsFromEngine();
    this.snapCameraToPlayer();
    this.statusRankingEl.style.display = 'none';
    this.statusOverlay.style.display = 'none';
    this.updateHud();
    this.playSynthTone(520, 0.1, 'sawtooth');
  }

  private clearArenaVisuals(): void {
    for (const v of this.cycleVisuals.values()) {
      this.gameGroup.remove(v.group);
    }
    this.cycleVisuals.clear();

    for (const m of this.trailMeshes.values()) {
      this.gameGroup.remove(m);
      m.geometry.dispose();
    }
    this.trailMeshes.clear();

    for (const s of this.shards) {
      this.gameGroup.remove(s.mesh);
      s.mesh.geometry.dispose();
    }
    this.shards = [];
  }

  private syncVisualsFromEngine(): void {
    for (const c of this.engine.cycles) {
      let vis = this.cycleVisuals.get(c.id);
      if (!vis) {
        const group = this.createLightCycleMesh(c.color);
        const targetYaw = dirToYaw(c.dir);
        group.rotation.y = targetYaw;
        this.gameGroup.add(group);
        vis = { group, yaw: targetYaw, bank: 0 };
        this.cycleVisuals.set(c.id, vis);
      }
      vis.group.visible = c.alive;
      vis.group.position.set(c.x, 0, c.z);
    }

    for (const seg of this.engine.segments) {
      this.updateTrailMesh(seg);
    }
  }

  private updateTrailMesh(seg: TrailSegment): void {
    let mesh = this.trailMeshes.get(seg.id);
    if (!mesh) {
      const geo = new THREE.BoxGeometry(1, 2.2, 1);
      mesh = new THREE.Mesh(geo, this.getTrailMaterial(seg.color));
      this.gameGroup.add(mesh);
      this.trailMeshes.set(seg.id, mesh);
    }

    const dx = Math.abs(seg.x2 - seg.x1);
    const dz = Math.abs(seg.z2 - seg.z1);
    const thickness = 0.48;
    const sx = Math.max(thickness, dx + thickness);
    const sz = Math.max(thickness, dz + thickness);

    mesh.scale.set(sx, 1, sz);
    mesh.position.set((seg.x1 + seg.x2) / 2, 1.1, (seg.z1 + seg.z2) / 2);
  }

  private spawnExplosion(x: number, z: number, color: BikeColor): void {
    const hex = COLOR_HEX[color];
    const mat = new THREE.MeshBasicMaterial({ color: hex });
    for (let i = 0; i < 24; i++) {
      const geo = new THREE.BoxGeometry(0.65, 0.65, 0.65);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 1.1, z);
      const angle = Math.random() * Math.PI * 2;
      const spd = 10 + Math.random() * 20;
      this.gameGroup.add(mesh);
      this.shards.push({
        mesh,
        vx: Math.cos(angle) * spd,
        vy: 6 + Math.random() * 14,
        vz: Math.sin(angle) * spd,
        life: 1.3 + Math.random() * 0.5,
      });
    }
    this.playSynthTone(130, 0.28, 'sawtooth');
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.exit();
      return;
    }
    if (this.engine.status !== 'playing') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.advanceOrRetry();
      }
      return;
    }
    if (this.engine.mode === 'local2p') {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.turn('left', 'p1');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.turn('right', 'p1');
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        this.turn('left', 'p2');
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        this.turn('right', 'p2');
      }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      this.turn('left', 'p1');
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      this.turn('right', 'p1');
    }
  }

  private snapCameraToPlayer(): void {
    const p = this.engine.getPlayer();
    if (p) {
      const v = DIR_VEC[p.dir];
      this.camPos.set(p.x - v.dx * 21, 9.5, p.z - v.dz * 21);
      this.camLook.set(p.x + v.dx * 16, 1.4, p.z + v.dz * 16);
    }
    if (this.engine.mode === 'local2p') {
      const p2 = this.engine.getPlayer2();
      if (p2) {
        const v2 = DIR_VEC[p2.dir];
        this.cam2Pos.set(p2.x - v2.dx * 21, 9.5, p2.z - v2.dz * 21);
        this.cam2Look.set(p2.x + v2.dx * 16, 1.4, p2.z + v2.dz * 16);
      }
      this.renderer.renderSplitScreen(
        { pos: this.camPos, lookAt: this.camLook },
        { pos: this.cam2Pos, lookAt: this.cam2Look },
        this.splitOrientation,
      );
      return;
    }
    this.renderer.setCameraOverride(this.camPos, this.camLook);
  }

  private updateCamera(dt: number): void {
    const alpha = 1 - Math.exp(-8 * dt);
    const stepCam = (c: CycleState | undefined, pos: THREE.Vector3, look: THREE.Vector3) => {
      if (!c) return;
      const v = DIR_VEC[c.dir];
      const desiredPos = c.alive
        ? new THREE.Vector3(c.x - v.dx * 21, 9.5, c.z - v.dz * 21)
        : new THREE.Vector3(c.x - v.dx * 30, 17, c.z - v.dz * 30);
      const desiredLook = new THREE.Vector3(c.x + v.dx * 16, 1.4, c.z + v.dz * 16);
      pos.lerp(desiredPos, alpha);
      look.lerp(desiredLook, alpha);
    };

    stepCam(this.engine.getPlayer(), this.camPos, this.camLook);
    if (this.engine.mode === 'local2p') {
      stepCam(this.engine.getPlayer2(), this.cam2Pos, this.cam2Look);
      return;
    }
    this.renderer.setCameraOverride(this.camPos, this.camLook);
  }

  private updateHud(): void {
    if (this.engine.mode === 'local2p') {
      this.levelEl.textContent = `LIGHT CYCLES · ${t('ui.tron.mode2pBadge')}`;
      this.botsEl.textContent = `P1 ${this.engine.p1Wins} × ${this.engine.p2Wins} P2`;
      this.scoreEl.textContent = `P1 ${this.engine.p1Wins} : ${this.engine.p2Wins} P2`;
      if (this.p1BadgeEl) this.p1BadgeEl.textContent = `PLAYER 1 · ← / →`;
      if (this.p2BadgeEl) this.p2BadgeEl.textContent = `PLAYER 2 · A / D`;
      return;
    }
    const aliveBots = this.engine.cycles.filter((c) => !c.isPlayer && c.alive).length;
    this.levelEl.textContent = `LIGHT CYCLES · ${t('ui.tron.level')} ${this.engine.level}`;
    this.botsEl.textContent = `${t('ui.tron.opponents')}: ${aliveBots}`;
    this.scoreEl.textContent = `SCORE : ${this.engine.score}`;
  }

  private drawMinimap(): void {
    const ctx = this.minimapCanvas.getContext('2d');
    if (!ctx) return;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const hs = this.engine.halfSize;
    const ox = this.engine.originX;
    const oz = this.engine.originZ;
    const toPxX = (val: number) => ((val - ox + hs) / (hs * 2)) * (w - 8) + 4;
    const toPxZ = (val: number) => ((val - oz + hs) / (hs * 2)) * (h - 8) + 4;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(4, 9, 20, 0.85)';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(4, 4, w - 8, h - 8);

    ctx.lineWidth = 2;
    for (const seg of this.engine.segments) {
      ctx.strokeStyle = COLOR_CSS[seg.color];
      ctx.beginPath();
      ctx.moveTo(toPxX(seg.x1), toPxZ(seg.z1));
      ctx.lineTo(toPxX(seg.x2), toPxZ(seg.z2));
      ctx.stroke();
    }

    for (const c of this.engine.cycles) {
      if (!c.alive) continue;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(toPxX(c.x), toPxZ(c.z), c.isPlayer ? 3.5 : 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    const dt = Math.min((now - this.lastTs) / 1000, 0.05);
    this.lastTs = now;
    this.frameCount++;

    if (this.engine.status === 'playing') {
      const events = this.engine.step(dt);
      for (const ev of events) {
        if (ev.type === 'crash') {
          this.spawnExplosion(ev.x, ev.z, ev.color);
          this.updateHud();
        }
      }

      // Faz papéis, notas e documentos da sala voarem quando qualquer moto passa perto (a cada 3 frames)
      if (this.frameCount % 3 === 0) {
        for (const c of this.engine.cycles) {
          if (!c.alive) continue;
          const v = DIR_VEC[c.dir];
          this.world.scatterObjectsNear(c.x, c.z, 9.5, v.dx, v.dz, this.boxId);
        }
      }

      if (this.engine.status !== 'playing') {
        this.showEndOverlay();
      }
    }

    for (const c of this.engine.cycles) {
      const vis = this.cycleVisuals.get(c.id);
      if (!vis) continue;
      vis.group.visible = c.alive;
      if (c.alive) {
        vis.group.position.set(c.x, 0, c.z);
        const targetYaw = dirToYaw(c.dir);
        vis.yaw = lerpAngle(vis.yaw, targetYaw, 1 - Math.exp(-16 * dt));
        vis.bank *= Math.exp(-6 * dt);
        vis.group.rotation.y = vis.yaw;
        vis.group.rotation.z = vis.bank;
      }
    }

    for (const seg of this.engine.segments) {
      this.updateTrailMesh(seg);
    }

    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.gameGroup.remove(s.mesh);
        s.mesh.geometry.dispose();
        this.shards.splice(i, 1);
        continue;
      }
      s.vy -= 22 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y = Math.max(0.25, s.mesh.position.y + s.vy * dt);
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += 5 * dt;
      s.mesh.rotation.y += 4 * dt;
    }

    this.updateCamera(dt);
    // Garante render a 60 FPS mesmo quando os itens do BumpTop estão em repouso (sleep optimization)
    if (this.engine.mode === 'local2p') {
      this.renderer.renderSplitScreen(
        { pos: this.camPos, lookAt: this.camLook },
        { pos: this.cam2Pos, lookAt: this.cam2Look },
        this.splitOrientation,
      );
    } else {
      this.renderer.render();
    }
    if (this.frameCount % 3 === 0) {
      this.drawMinimap();
    }
  };

  private showEndOverlay(): void {
    if (this.engine.mode === 'local2p') {
      const w = this.engine.winner;
      if (w === 'p1') {
        this.statusTitleEl.textContent = t('ui.tron.p1Wins');
        this.statusTitleEl.style.color = '#00d2ff';
      } else if (w === 'p2') {
        this.statusTitleEl.textContent = t('ui.tron.p2Wins');
        this.statusTitleEl.style.color = '#ff2a55';
      } else {
        this.statusTitleEl.textContent = t('ui.tron.drawTitle');
        this.statusTitleEl.style.color = '#facc15';
      }
      this.statusSubEl.textContent = `Player 1 (${this.engine.p1Wins}) × (${this.engine.p2Wins}) Player 2`;
      this.nextBtn.textContent = t('ui.tron.nextRound');
      this.statusRankingEl.style.display = 'none';
      this.statusOverlay.style.display = 'flex';
      this.updateHud();
      return;
    }

    const won = this.engine.status === 'won';
    this.maxLevelReached = Math.max(this.maxLevelReached, this.engine.level);
    this.statusTitleEl.textContent = won ? t('ui.tron.wonTitle') : t('ui.tron.lostTitle');
    this.statusTitleEl.style.color = won ? '#4ade80' : '#ff2a55';
    this.statusSubEl.textContent = won
      ? t('ui.tron.wonSub', { score: this.engine.score, level: this.engine.level + 1 })
      : t('ui.tron.lostSub', { score: this.engine.score });
    this.nextBtn.textContent = won ? t('ui.tron.nextLevel') : t('ui.tron.retry');

    if (this.rankingOpts?.isLoggedIn && this.rankingOpts.onScoreSubmit) {
      if (!won) {
        this.statusRankingEl.style.display = 'block';
        this.statusRankingEl.textContent = '...';
      } else {
        this.statusRankingEl.style.display = 'none';
      }
      void this.rankingOpts
        .onScoreSubmit(this.engine.score, this.maxLevelReached)
        .then((data) => {
          if (!won && this.statusOverlay.style.display !== 'none') {
            renderTronRankingBox(this.statusRankingEl, data);
          }
        });
    } else {
      this.statusRankingEl.style.display = 'none';
    }

    this.statusOverlay.style.display = 'flex';
  }

  private playSynthTone(freq: number, dur: number, type: OscillatorType): void {
    try {
      const Ctx = window.AudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + dur);
      osc.onended = () => void ac.close();
    } catch {
      // Sem áudio (ex.: headless)
    }
  }

  exit(): void {
    const cb = this.onExitCb;
    this.dispose();
    cb?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.clearArenaVisuals();
    for (const m of this.trailMatCache.values()) m.dispose();
    this.trailMatCache.clear();
    this.renderer.getScene().remove(this.gameGroup);
    this.renderer.setCameraOverride(null);
    // Restaura a posição original dos papéis e documentos após o minigame
    this.world.loadSnapshot(this.preGameSnapshot);
    this.container.remove();
  }
}

function dirToYaw(dir: CycleState['dir']): number {
  if (dir === 0) return 0;
  if (dir === 1) return -Math.PI / 2;
  if (dir === 2) return Math.PI;
  return Math.PI / 2;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
