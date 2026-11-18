/**
 * PR4.4 — BuildingView
 *
 * Renderiza as caixas (BoxEntityData) como andares empilhados de um prédio 3D.
 * Inspirado no ARC0050 (HorizonX) e portado para TypeScript puro + Three.js.
 *
 * Ciclo de vida:
 *   1. `mount(canvas)` → cria cena Three.js sobreposta ao canvas do BumpTop
 *   2. `setBoxes(list)` → atualiza andares
 *   3. `show() / hide()` → fade in/out
 *   4. `onFloorClick(cb)` → callback quando usuário clica num andar
 *   5. `dispose()` → limpa tudo
 */
import * as THREE from 'three';
import type { BoxType } from '@core/ports/index';
import type { BoxEntityData } from '@core/model/types';

// Cores por tipo de caixa
const FLOOR_COLOR: Record<BoxType, number> = {
  comum:   0x4a5568,
  root:    0x2d9e6b,
  kanban:  0xe8733a,
  backlog: 0x7b4ac8,
};

const FLOOR_HEIGHT  = 3.2;   // m por andar
const FLOOR_WIDTH   = 24;    // largura base
const FLOOR_DEPTH   = 16;    // profundidade base
const FLOOR_GAP     = 0.15;  // gap entre andares
const SELECTED_OPACITY = 0.9;
const DEFAULT_OPACITY  = 0.38;
const DIM_OPACITY      = 0.08;

export type FloorClickCallback = (boxId: string) => void;

export class BuildingView {
  private container!: HTMLDivElement;
  private scene!:    THREE.Scene;
  private camera!:   THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private group =    new THREE.Group();
  private raf = 0;

  // Câmera órbita
  private cam = { theta: 0.5, phi: 0.95, dist: 180, ty: 60 };
  private drag = { down: false, lx: 0, ly: 0 };

  private floors: Array<{ id: string; mesh: THREE.Mesh; edges: THREE.LineSegments }> = [];
  private selectedId: string | null = null;
  private clickCb: FloorClickCallback | null = null;

  private visible = false;
  private fadeAlpha = 0;      // 0 = oculto, 1 = visível
  private fadeDir   = 0;      // +1 = aparecendo, -1 = sumindo
  private fadeCb: (() => void) | null = null;

  // ── Mount ────────────────────────────────────────────────
  mount(parent: HTMLElement): void {
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      position: 'absolute', inset: '0',
      zIndex: '50',
      opacity: '0',
      pointerEvents: 'none',
      transition: 'none',
    });
    parent.appendChild(this.container);

    const w = parent.clientWidth  || window.innerWidth;
    const h = parent.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);
    this.scene.fog = new THREE.Fog(0x0d1117, 300, 600);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.container.appendChild(this.renderer.domElement);

    // Luzes
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(60, 120, 80);
    this.scene.add(dir);

    // Chão grade
    const grid = new THREE.GridHelper(300, 20, 0x222233, 0x1a1a2a);
    this.scene.add(grid);

    this.scene.add(this.group);

    this._bindEvents(w, h);
    this._tick();
  }

  // ── Resize ────────────────────────────────────────────────
  private _bindEvents(w: number, h: number): void {
    const cvs = this.renderer.domElement;
    const getXY = (e: MouseEvent | TouchEvent) =>
      'touches' in e ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];

    cvs.addEventListener('mousedown',  (e) => { const [x,y]=getXY(e); this.drag={down:true,lx:x,ly:y}; });
    cvs.addEventListener('mouseup',    ()  => { this.drag.down=false; });
    cvs.addEventListener('mousemove',  (e) => {
      if (!this.drag.down) return;
      const [x,y]=getXY(e);
      const dx=x-this.drag.lx, dy=y-this.drag.ly;
      this.drag.lx=x; this.drag.ly=y;
      this.cam.theta -= dx * 0.005;
      this.cam.phi = Math.max(0.15, Math.min(Math.PI-0.15, this.cam.phi - dy*0.005));
    });
    cvs.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(60, Math.min(400, this.cam.dist + e.deltaY * 0.1));
    }, { passive: false });

    // Click num andar
    cvs.addEventListener('click', (e) => {
      if (!this.clickCb) return;
      const rect = cvs.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
      const my = ((e.clientY - rect.top)  / rect.height) * -2 + 1;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(mx, my), this.camera);
      const meshes = this.floors.map(f => f.mesh);
      const hits = ray.intersectObjects(meshes);
      if (hits.length) {
        const hit = hits[0].object;
        const floor = this.floors.find(f => f.mesh === hit);
        if (floor) {
          this.selectedId = floor.id;
          this._rebuild(this.floors.map(f => ({
            id: f.id,
            type: (f.mesh.userData['boxType'] as BoxType) ?? 'comum',
          })));
          this.clickCb(floor.id);
        }
      }
    });

    // Resize
    window.addEventListener('resize', () => {
      const nw = this.container.clientWidth  || window.innerWidth;
      const nh = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = nw / nh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(nw, nh);
    });

    void w; void h; // usados na criação
  }

  // ── Tick ─────────────────────────────────────────────────
  private _tick(): void {
    this.raf = requestAnimationFrame(() => this._tick());

    // Fade
    if (this.fadeDir !== 0) {
      this.fadeAlpha = Math.max(0, Math.min(1, this.fadeAlpha + this.fadeDir * 0.045));
      this.container.style.opacity = String(this.fadeAlpha);
      if (this.fadeAlpha <= 0 && this.fadeDir < 0) {
        this.fadeDir = 0;
        this.container.style.pointerEvents = 'none';
        this.fadeCb?.(); this.fadeCb = null;
      } else if (this.fadeAlpha >= 1 && this.fadeDir > 0) {
        this.fadeDir = 0;
        this.container.style.pointerEvents = 'auto';
        this.fadeCb?.(); this.fadeCb = null;
      }
    }

    // Câmera órbita
    const c = this.cam;
    this.camera.position.set(
      c.dist * Math.sin(c.phi) * Math.cos(c.theta),
      c.dist * Math.cos(c.phi) + c.ty,
      c.dist * Math.sin(c.phi) * Math.sin(c.theta),
    );
    this.camera.lookAt(0, c.ty, 0);

    this.renderer.render(this.scene, this.camera);
  }

  // ── Setboxes ─────────────────────────────────────────────
  setBoxes(boxes: BoxEntityData[]): void {
    this._rebuild(boxes.map(b => ({ id: b.id, type: b.type })));
  }

  private _rebuild(items: Array<{ id: string; type: BoxType }>): void {
    // Remove old
    for (const f of this.floors) {
      if (f.mesh.geometry)  f.mesh.geometry.dispose();
      if (f.edges.geometry) f.edges.geometry.dispose();
      (Array.isArray(f.mesh.material) ? f.mesh.material : [f.mesh.material]).forEach(m => (m as THREE.Material).dispose());
      this.group.remove(f.mesh, f.edges);
    }
    this.floors = [];

    if (items.length === 0) {
      // Prédio vazio — um "chão" placeholder
      items = [{ id: '__empty__', type: 'comum' }];
    }

    const geo = new THREE.BoxGeometry(FLOOR_WIDTH, FLOOR_HEIGHT - FLOOR_GAP, FLOOR_DEPTH);

    let y = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSel = this.selectedId === item.id;
      const hasSelection = this.selectedId !== null;

      const color = isSel
        ? new THREE.Color(FLOOR_COLOR[item.type]).multiplyScalar(1.4)
        : new THREE.Color(FLOOR_COLOR[item.type]);

      const opacity = isSel ? SELECTED_OPACITY : hasSelection ? DIM_OPACITY : DEFAULT_OPACITY;

      const mat = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity,
        depthWrite: !hasSelection || isSel,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, y + (FLOOR_HEIGHT - FLOOR_GAP) / 2, 0);
      mesh.userData['boxType'] = item.type;
      mesh.userData['boxId']   = item.id;

      // Wireframe edges
      const edgeMat = new THREE.LineBasicMaterial({
        color: isSel ? FLOOR_COLOR[item.type] : 0x666688,
        transparent: true,
        opacity: isSel ? 1 : 0.3,
      });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edges.position.copy(mesh.position);

      this.group.add(mesh, edges);
      this.floors.push({ id: item.id, mesh, edges });

      // Rótulo (andar N)
      this._addLabel(i + 1, item.id, mesh.position.clone().setX(-FLOOR_WIDTH / 2 - 2));

      y += FLOOR_HEIGHT;
    }

    // Recentra câmera no meio do prédio
    this.cam.ty = (y / 2);
  }

  private _addLabel(floor: number, id: string, pos: THREE.Vector3): void {
    // Label via CSS3D seria ideal; aqui usamos um sprite canvas simples
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 24;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, 64, 24);
    ctx.fillStyle = this.selectedId === id ? '#E8733A' : '#888899';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`F${floor}`, 60, 17);

    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.scale.set(8, 3, 1);
    sprite.position.copy(pos);
    this.group.add(sprite);
  }

  // ── Visibilidade ─────────────────────────────────────────
  show(cb?: () => void): void {
    if (this.visible) { cb?.(); return; }
    this.visible = true;
    this.fadeDir = 1;
    this.fadeCb  = cb ?? null;
  }

  hide(cb?: () => void): void {
    if (!this.visible) { cb?.(); return; }
    this.visible = false;
    this.fadeDir = -1;
    this.fadeCb  = cb ?? null;
  }

  isVisible(): boolean { return this.visible; }

  // ── Callback ─────────────────────────────────────────────
  onFloorClick(cb: FloorClickCallback): void { this.clickCb = cb; }

  // ── Select externo ───────────────────────────────────────
  selectFloor(id: string | null): void {
    this.selectedId = id;
    this._rebuild(this.floors.map(f => ({
      id: f.id,
      type: (f.mesh.userData['boxType'] as BoxType) ?? 'comum',
    })));
  }

  // ── Dispose ──────────────────────────────────────────────
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.container.remove();
  }
}
