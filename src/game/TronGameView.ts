import * as THREE from 'three';
import {
  DIR_VEC,
  TronEngine,
  type BikeColor,
  type CycleState,
  type PlayerBikeColor,
  type TrailSegment,
} from './tronEngine';
import { t } from '@core/i18n/i18n';

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

export class TronGameView {
  private container: HTMLDivElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
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
  private nextBtn!: HTMLButtonElement;
  private minimapCanvas!: HTMLCanvasElement;

  private camPos = new THREE.Vector3(0, 14, 70);
  private camLook = new THREE.Vector3(0, 1, 40);
  private raf = 0;
  private lastTs = 0;
  private disposed = false;
  private onExitCb: (() => void) | null = null;
  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onResizeBound: () => void;

  constructor(parent: HTMLElement, playerColor: PlayerBikeColor, onExit: () => void) {
    this.onExitCb = onExit;
    this.engine = new TronEngine({ halfSize: 85, playerColor, level: 1 });

    // Container fullscreen acima do BuildingView e HUD
    this.container = document.createElement('div');
    this.container.className = 'tron-game-container';

    // Renderer Three.js
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.domElement.style.display = 'block';
    this.container.appendChild(this.renderer.domElement);

    // Cena e neblina cyber
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030610);
    this.scene.fog = new THREE.FogExp2(0x030610, 0.0052);

    this.camera = new THREE.PerspectiveCamera(
      65,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.2,
      400,
    );

    this.buildLights();
    this.buildArena();
    this.buildHud();
    this.syncVisualsFromEngine();
    this.snapCameraToPlayer();

    parent.appendChild(this.container);

    // Listeners de teclado & resize
    this.onKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);
    this.onResizeBound = () => this.handleResize();
    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('resize', this.onResizeBound);

    this.lastTs = performance.now();
    this.playSynthTone(440, 0.12, 'sawtooth');
    this.loop(this.lastTs);
  }

  private buildLights(): void {
    const ambient = new THREE.AmbientLight(0x8899cc, 0.9);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(30, 80, 40);
    this.scene.add(dir);

    const rim = new THREE.DirectionalLight(0x8b5cf6, 0.65);
    rim.position.set(-50, 30, -60);
    this.scene.add(rim);
  }

  private buildArena(): void {
    const hs = this.engine.halfSize;
    const size = hs * 2;

    // Piso escuro brilhante
    const floorGeo = new THREE.PlaneGeometry(size, size);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x050814,
      roughness: 0.35,
      metalness: 0.65,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Grade neon estilo TRON (roxo/branco como nas referências)
    const gridMain = new THREE.GridHelper(size, 34, 0x9333ea, 0x4c1d95);
    gridMain.position.y = 0.03;
    this.scene.add(gridMain);

    const gridSub = new THREE.GridHelper(size, 17, 0x38bdf8, 0x6d28d9);
    gridSub.position.y = 0.04;
    const mats = Array.isArray(gridSub.material) ? gridSub.material : [gridSub.material];
    for (const m of mats) {
      m.transparent = true;
      m.opacity = 0.45;
    }
    this.scene.add(gridSub);

    // Paredes translúcidas neon do perímetro
    const wallH = 6.5;
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x00d2ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });

    const wallSpecs: Array<{ w: number; d: number; x: number; z: number; ry: number }> = [
      { w: size, d: 0.4, x: 0, z: -hs, ry: 0 },
      { w: size, d: 0.4, x: 0, z: hs, ry: 0 },
      { w: size, d: 0.4, x: -hs, z: 0, ry: Math.PI / 2 },
      { w: size, d: 0.4, x: hs, z: 0, ry: Math.PI / 2 },
    ];

    for (const ws of wallSpecs) {
      const geo = new THREE.BoxGeometry(ws.w, wallH, ws.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(ws.x, wallH / 2, ws.z);
      mesh.rotation.y = ws.ry;
      this.scene.add(mesh);

      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      this.scene.add(edges);
    }
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
      emissiveIntensity: 1.6,
      roughness: 0.2,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      emissive: hex,
      emissiveIntensity: 0.35,
      roughness: 0.1,
      metalness: 0.9,
    });

    // Chassi aerodinâmico principal (frente aponta para -Z)
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.72, 3.2), bodyMat);
    chassis.position.set(0, 0.78, 0);
    group.add(chassis);

    // Carenagem/visor superior neon
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.48, 1.85), glassMat);
    canopy.position.set(0, 1.24, -0.15);
    group.add(canopy);

    // Faixa central luminosa no topo
    const topStrip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 2.9), neonMat);
    topStrip.position.set(0, 1.5, -0.05);
    group.add(topStrip);

    // Rodas de luz dianteira e traseira
    const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.46, 20);
    wheelGeo.rotateZ(Math.PI / 2);

    const frontWheel = new THREE.Mesh(wheelGeo, neonMat);
    frontWheel.position.set(0, 0.62, -1.35);
    group.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelGeo, neonMat);
    rearWheel.position.set(0, 0.62, 1.35);
    group.add(rearWheel);

    // Laterais luminosas
    const sideGeo = new THREE.BoxGeometry(0.08, 0.26, 2.3);
    const leftSide = new THREE.Mesh(sideGeo, neonMat);
    leftSide.position.set(-0.5, 0.75, 0);
    const rightSide = new THREE.Mesh(sideGeo, neonMat);
    rightSide.position.set(0.5, 0.75, 0);
    group.add(leftSide, rightSide);

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
    // Barra superior esquerda: Nível + Bots + Dica
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

    // Barra superior direita: Minimap + Botão Sair
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

    // Score retrô amarelo no canto inferior esquerdo (como nas referências)
    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'tron-score';
    this.scoreEl.textContent = 'SCORE : 0';
    this.container.appendChild(this.scoreEl);

    // Botões de toque (esquerda/direita) para celular ou clique direto
    const touchWrap = document.createElement('div');
    touchWrap.className = 'tron-touch-controls';
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

    // Overlay de vitória / derrota
    this.statusOverlay = document.createElement('div');
    this.statusOverlay.className = 'tron-status-overlay';
    this.statusOverlay.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'tron-status-card';

    this.statusTitleEl = document.createElement('h2');
    this.statusTitleEl.className = 'tron-status-title';

    this.statusSubEl = document.createElement('p');
    this.statusSubEl.className = 'tron-status-sub';

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
    card.append(this.statusTitleEl, this.statusSubEl, btnRow);
    this.statusOverlay.appendChild(card);
    this.container.appendChild(this.statusOverlay);

    this.updateHud();
  }

  private turn(side: 'left' | 'right'): void {
    if (this.engine.turnPlayer(side)) {
      this.playSynthTone(620, 0.05, 'square');
      const player = this.engine.getPlayer();
      const vis = player ? this.cycleVisuals.get(player.id) : undefined;
      if (vis) {
        vis.bank = side === 'left' ? 0.36 : -0.36;
      }
    }
  }

  private advanceOrRetry(): void {
    if (this.engine.status === 'won') {
      this.engine.level += 1;
    } else {
      this.engine.level = 1;
      this.engine.score = 0;
    }
    this.clearArenaVisuals();
    this.engine.resetRound();
    this.syncVisualsFromEngine();
    this.snapCameraToPlayer();
    this.statusOverlay.style.display = 'none';
    this.updateHud();
    this.playSynthTone(520, 0.1, 'sawtooth');
  }

  private clearArenaVisuals(): void {
    for (const v of this.cycleVisuals.values()) {
      this.scene.remove(v.group);
    }
    this.cycleVisuals.clear();

    for (const m of this.trailMeshes.values()) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.trailMeshes.clear();

    for (const s of this.shards) {
      this.scene.remove(s.mesh);
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
        this.scene.add(group);
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
      const geo = new THREE.BoxGeometry(1, 1.9, 1);
      mesh = new THREE.Mesh(geo, this.getTrailMaterial(seg.color));
      this.scene.add(mesh);
      this.trailMeshes.set(seg.id, mesh);
    }

    const dx = Math.abs(seg.x2 - seg.x1);
    const dz = Math.abs(seg.z2 - seg.z1);
    const thickness = 0.42;
    const sx = Math.max(thickness, dx + thickness);
    const sz = Math.max(thickness, dz + thickness);

    mesh.scale.set(sx, 1, sz);
    mesh.position.set((seg.x1 + seg.x2) / 2, 0.95, (seg.z1 + seg.z2) / 2);
  }

  private spawnExplosion(x: number, z: number, color: BikeColor): void {
    const hex = COLOR_HEX[color];
    const mat = new THREE.MeshBasicMaterial({ color: hex });
    for (let i = 0; i < 22; i++) {
      const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 1.0, z);
      const angle = Math.random() * Math.PI * 2;
      const spd = 8 + Math.random() * 18;
      this.scene.add(mesh);
      this.shards.push({
        mesh,
        vx: Math.cos(angle) * spd,
        vy: 5 + Math.random() * 12,
        vz: Math.sin(angle) * spd,
        life: 1.2 + Math.random() * 0.5,
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
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      this.turn('left');
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      this.turn('right');
    }
  }

  private handleResize(): void {
    if (this.disposed) return;
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private snapCameraToPlayer(): void {
    const p = this.engine.getPlayer();
    if (!p) return;
    const v = DIR_VEC[p.dir];
    this.camPos.set(p.x - v.dx * 17, 7.6, p.z - v.dz * 17);
    this.camLook.set(p.x + v.dx * 14, 1.2, p.z + v.dz * 14);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  private updateCamera(dt: number): void {
    const p = this.engine.getPlayer();
    if (!p) return;
    const v = DIR_VEC[p.dir];
    const desiredPos = p.alive
      ? new THREE.Vector3(p.x - v.dx * 17, 7.6, p.z - v.dz * 17)
      : new THREE.Vector3(p.x - v.dx * 26, 15, p.z - v.dz * 26);
    const desiredLook = new THREE.Vector3(p.x + v.dx * 14, 1.1, p.z + v.dz * 14);

    const alpha = 1 - Math.exp(-8 * dt);
    this.camPos.lerp(desiredPos, alpha);
    this.camLook.lerp(desiredLook, alpha);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  private updateHud(): void {
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
    const toPx = (val: number) => ((val + hs) / (hs * 2)) * (w - 8) + 4;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(4, 9, 20, 0.85)';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(4, 4, w - 8, h - 8);

    // Trilhas
    ctx.lineWidth = 2;
    for (const seg of this.engine.segments) {
      ctx.strokeStyle = COLOR_CSS[seg.color];
      ctx.beginPath();
      ctx.moveTo(toPx(seg.x1), toPx(seg.z1));
      ctx.lineTo(toPx(seg.x2), toPx(seg.z2));
      ctx.stroke();
    }

    // Motos vivas
    for (const c of this.engine.cycles) {
      if (!c.alive) continue;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(toPx(c.x), toPx(c.z), c.isPlayer ? 3.5 : 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    const dt = Math.min((now - this.lastTs) / 1000, 0.05);
    this.lastTs = now;

    if (this.engine.status === 'playing') {
      const events = this.engine.step(dt);
      for (const ev of events) {
        if (ev.type === 'crash') {
          this.spawnExplosion(ev.x, ev.z, ev.color);
          this.updateHud();
        }
      }

      if (this.engine.status !== 'playing') {
        this.showEndOverlay();
      }
    }

    // Atualiza posições e inclinação (bank) das motos
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

    // Atualiza trilhas de luz
    for (const seg of this.engine.segments) {
      this.updateTrailMesh(seg);
    }

    // Atualiza partículas de desintegração
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
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
    this.drawMinimap();
    this.renderer.render(this.scene, this.camera);
  };

  private showEndOverlay(): void {
    const won = this.engine.status === 'won';
    this.statusTitleEl.textContent = won ? t('ui.tron.wonTitle') : t('ui.tron.lostTitle');
    this.statusTitleEl.style.color = won ? '#4ade80' : '#ff2a55';
    this.statusSubEl.textContent = won
      ? t('ui.tron.wonSub', { score: this.engine.score, level: this.engine.level + 1 })
      : t('ui.tron.lostSub', { score: this.engine.score });
    this.nextBtn.textContent = won ? t('ui.tron.nextLevel') : t('ui.tron.retry');
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
    window.removeEventListener('resize', this.onResizeBound);
    this.clearArenaVisuals();
    for (const m of this.trailMatCache.values()) m.dispose();
    this.trailMatCache.clear();
    this.renderer.dispose();
    this.container.remove();
  }
}

function dirToYaw(dir: CycleState['dir']): number {
  // Frente do mesh aponta para -Z (yaw = 0 -> Norte)
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
