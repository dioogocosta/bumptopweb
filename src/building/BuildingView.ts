/**
 * PR4.4 — BuildingView
 *
 * Renderiza as caixas (BoxEntityData) como andares empilhados de um prédio 3D.
 * Inspirado no ARC0050 (HorizonX) e portado para TypeScript puro + Three.js.
 */
import * as THREE from 'three';
import type { BoxType } from '@core/ports/index';
import type { BoxEntityData } from '@core/model/types';

// Cores por tipo de caixa
const FLOOR_COLOR: Record<BoxType, number> = {
  comum:   0x5a6a80,
  root:    0x22c55e,
  kanban:  0xf97316,
  backlog: 0x8b5cf6,
};

const FLOOR_HEIGHT     = 4.2;   // altura de cada andar
const FLOOR_WIDTH      = 28;    // largura base
const FLOOR_DEPTH      = 18;    // profundidade base
const FLOOR_GAP        = 0.35;  // gap entre andares
const SELECTED_OPACITY = 0.95;
const DEFAULT_OPACITY  = 0.45;
const DIM_OPACITY      = 0.15;

export type FloorClickCallback = (boxId: string) => void;

export class BuildingView {
  private container!: HTMLDivElement;
  private tooltip!:   HTMLDivElement;
  private scene!:     THREE.Scene;
  private camera!:    THREE.PerspectiveCamera;
  private renderer!:  THREE.WebGLRenderer;
  private group =     new THREE.Group();
  private raf = 0;

  // Câmera órbita — theta ~ 2.35 rad (135°) posiciona a câmera à frente dos textos de cada andar
  private cam = { theta: 2.35, phi: 1.15, dist: 90, ty: 15 };
  private drag = { down: false, lx: 0, ly: 0 };

  private rawBoxes: BoxEntityData[] = [];
  private floors: Array<{ id: string; mesh: THREE.Mesh; edges: THREE.LineSegments; sprite?: THREE.Sprite }> = [];
  private clickableObjects: THREE.Object3D[] = [];
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
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

    // Tooltip flutuante
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'building-tooltip';
    Object.assign(this.tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      background: 'rgba(15, 23, 42, 0.92)',
      border: '1px solid rgba(99, 179, 237, 0.4)',
      color: '#e2e8f0',
      borderRadius: '6px',
      padding: '5px 10px',
      fontSize: '12px',
      fontFamily: 'sans-serif',
      fontWeight: '500',
      zIndex: '60',
      display: 'none',
      transform: 'translate(-50%, -140%)',
      backdropFilter: 'blur(8px)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      whiteSpace: 'nowrap',
    });
    this.container.appendChild(this.tooltip);

    const w = parent.clientWidth  || window.innerWidth;
    const h = parent.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f16);
    this.scene.fog = new THREE.Fog(0x0a0f16, 200, 500);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.container.appendChild(this.renderer.domElement);

    // Luzes
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.85);
    dir1.position.set(60, 120, 80);
    this.scene.add(dir1);

    const dir2 = new THREE.DirectionalLight(0x63b3ed, 0.35);
    dir2.position.set(-60, 40, -80);
    this.scene.add(dir2);

    // Chão grade
    const grid = new THREE.GridHelper(300, 24, 0x1e293b, 0x0f172a);
    this.scene.add(grid);

    this.scene.add(this.group);

    this._bindEvents();
    this._tick();
  }

  // ── Eventos ────────────────────────────────────────────────
  private _bindEvents(): void {
    const cvs = this.renderer.domElement;
    cvs.style.cursor = 'grab';

    const getXY = (e: MouseEvent | TouchEvent) =>
      'touches' in e && e.touches.length > 0
        ? [e.touches[0].clientX, e.touches[0].clientY]
        : [('clientX' in e ? e.clientX : 0), ('clientY' in e ? e.clientY : 0)];

    let downPos = { x: 0, y: 0 };
    let hasDragged = false;

    cvs.addEventListener('mousedown', (e) => {
      const [x, y] = getXY(e);
      this.drag = { down: true, lx: x, ly: y };
      downPos = { x, y };
      hasDragged = false;
      cvs.style.cursor = 'grabbing';
    });

    window.addEventListener('mouseup', () => {
      this.drag.down = false;
      cvs.style.cursor = this.hoveredId ? 'pointer' : 'grab';
    });

    cvs.addEventListener('mousemove', (e) => {
      const [x, y] = getXY(e);
      if (this.drag.down) {
        const dx = x - this.drag.lx;
        const dy = y - this.drag.ly;
        if (Math.hypot(x - downPos.x, y - downPos.y) > 4) {
          hasDragged = true;
          this.tooltip.style.display = 'none';
        }
        this.drag.lx = x;
        this.drag.ly = y;
        this.cam.theta -= dx * 0.005;
        this.cam.phi = Math.max(0.15, Math.min(Math.PI - 0.15, this.cam.phi - dy * 0.005));
      } else {
        this._handleHover(x, y, cvs);
      }
    });

    cvs.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(30, Math.min(300, this.cam.dist + e.deltaY * 0.1));
    }, { passive: false });

    // Click num andar
    cvs.addEventListener('click', (e) => {
      if (hasDragged) return; // Arraste de câmera não aciona clique
      const [x, y] = getXY(e);
      const rect = cvs.getBoundingClientRect();
      const mx = ((x - rect.left) / rect.width) * 2 - 1;
      const my = ((y - rect.top) / rect.height) * -2 + 1;

      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(mx, my), this.camera);
      const hits = ray.intersectObjects(this.clickableObjects, true);

      if (hits.length > 0) {
        const hit = hits[0].object;
        const boxId = hit.userData['boxId'] as string | undefined;
        if (boxId && boxId !== '__empty__') {
          this.selectedId = boxId;
          this._highlightSelected();
          this.clickCb?.(boxId);
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
  }

  // ── Hover ────────────────────────────────────────────────
  private _handleHover(x: number, y: number, cvs: HTMLCanvasElement): void {
    const rect = cvs.getBoundingClientRect();
    const mx = ((x - rect.left) / rect.width) * 2 - 1;
    const my = ((y - rect.top) / rect.height) * -2 + 1;

    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(mx, my), this.camera);
    const hits = ray.intersectObjects(this.clickableObjects, true);

    if (hits.length > 0) {
      const hit = hits[0].object;
      const boxId = hit.userData['boxId'] as string | undefined;
      const boxName = hit.userData['boxName'] as string | undefined;
      const floorNum = hit.userData['floorNum'] as number | undefined;

      if (boxId && boxId !== '__empty__') {
        this.hoveredId = boxId;
        cvs.style.cursor = 'pointer';
        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = `${y}px`;
        this.tooltip.textContent = `F${floorNum ?? 1} · ${boxName ?? 'Caixa'}`;
        return;
      }
    }

    this.hoveredId = null;
    cvs.style.cursor = 'grab';
    this.tooltip.style.display = 'none';
  }

  // ── Tick ─────────────────────────────────────────────────
  private _tick(): void {
    this.raf = requestAnimationFrame(() => this._tick());

    // Fade
    if (this.fadeDir !== 0) {
      this.fadeAlpha = Math.max(0, Math.min(1, this.fadeAlpha + this.fadeDir * 0.05));
      this.container.style.opacity = String(this.fadeAlpha);
      if (this.fadeAlpha <= 0 && this.fadeDir < 0) {
        this.fadeDir = 0;
        this.container.style.pointerEvents = 'none';
        this.tooltip.style.display = 'none';
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
    this.rawBoxes = [...boxes];
    this._rebuild();
  }

  private _rebuild(): void {
    // Limpa objetos antigos de forma completa
    while (this.group.children.length > 0) {
      const c = this.group.children[0];
      if ('geometry' in c && (c as THREE.Mesh).geometry) {
        (c as THREE.Mesh).geometry.dispose();
      }
      if ('material' in c) {
        const m = (c as THREE.Mesh).material;
        if (Array.isArray(m)) {
          m.forEach((mat) => {
            if ('map' in mat && (mat as { map?: THREE.Texture }).map) {
              (mat as { map: THREE.Texture }).map.dispose();
            }
            mat.dispose();
          });
        } else if (m) {
          if ('map' in m && (m as { map?: THREE.Texture }).map) {
            (m as { map: THREE.Texture }).map.dispose();
          }
          m.dispose();
        }
      }
      this.group.remove(c);
    }

    this.floors = [];
    this.clickableObjects = [];

    const items = this.rawBoxes.length > 0
      ? this.rawBoxes
      : [{ id: '__empty__', name: 'Caixa Comum', type: 'comum' as BoxType, pos: { x: 0, z: 0 }, halfSize: 40, wallHeight: 20, wallThickness: 2 }];

    const geo = new THREE.BoxGeometry(FLOOR_WIDTH, FLOOR_HEIGHT - FLOOR_GAP, FLOOR_DEPTH);

    let y = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSel = this.selectedId === item.id;
      const hasSelection = this.selectedId !== null;

      const baseColor = FLOOR_COLOR[item.type] ?? FLOOR_COLOR.comum;
      const color = isSel
        ? new THREE.Color(baseColor).multiplyScalar(1.5)
        : new THREE.Color(baseColor);

      const opacity = isSel ? SELECTED_OPACITY : hasSelection ? DIM_OPACITY : DEFAULT_OPACITY;

      const mat = new THREE.MeshPhongMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: !hasSelection || isSel,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, y + (FLOOR_HEIGHT - FLOOR_GAP) / 2, 0);
      mesh.userData = {
        boxId: item.id,
        boxName: item.name,
        floorNum: i + 1,
        boxType: item.type,
      };

      // Wireframe edges
      const edgeMat = new THREE.LineBasicMaterial({
        color: isSel ? 0xffffff : baseColor,
        transparent: true,
        opacity: isSel ? 1 : 0.45,
      });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edges.position.copy(mesh.position);

      this.group.add(mesh, edges);
      this.clickableObjects.push(mesh);

      // Sprite de rótulo (F1, F2...) com nome da caixa
      const sprite = this._createLabelSprite(i + 1, item.name, item.id, isSel);
      sprite.position.set(-FLOOR_WIDTH / 2 - 3.5, mesh.position.y, 0);
      sprite.userData = {
        boxId: item.id,
        boxName: item.name,
        floorNum: i + 1,
      };
      this.group.add(sprite);
      this.clickableObjects.push(sprite);

      this.floors.push({ id: item.id, mesh, edges, sprite });

      y += FLOOR_HEIGHT;
    }

    // Enquadra a câmera perfeitamente no centro e altura do prédio
    const totalH = Math.max(1, items.length) * FLOOR_HEIGHT;
    this.cam.ty = totalH / 2;
    this.cam.dist = Math.max(48, Math.min(160, totalH * 2.6 + 36));
    this.cam.theta = 2.35;
    this.cam.phi = 1.15;
  }

  private _createLabelSprite(floor: number, name: string, _id: string, isSel: boolean): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 48;
    const ctx = canvas.getContext('2d')!;

    // Fundo pill
    ctx.fillStyle = isSel ? 'rgba(232, 115, 58, 0.9)' : 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(99, 179, 237, 0.45)';
    ctx.lineWidth = 2;

    const r = 8;
    ctx.beginPath();
    ctx.roundRect(4, 4, 248, 40, r);
    ctx.fill();
    ctx.stroke();

    // Texto
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const cleanName = (name || `Caixa ${floor}`).slice(0, 16);
    ctx.fillText(`F${floor} · ${cleanName}`, 14, 24);

    const tex = new THREE.CanvasTexture(canvas);
    // depthTest: false e renderOrder elevado garantem que os textos fiquem sempre legíveis na frente
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 999;
    sprite.scale.set(16, 3, 1);
    return sprite;
  }

  private _highlightSelected(): void {
    for (const f of this.floors) {
      const isSel = f.id === this.selectedId;
      const mat = f.mesh.material as THREE.MeshPhongMaterial;
      const type = (f.mesh.userData['boxType'] as BoxType) ?? 'comum';
      const baseColor = FLOOR_COLOR[type] ?? FLOOR_COLOR.comum;

      if (isSel) {
        mat.color.set(baseColor).multiplyScalar(1.5);
        mat.opacity = SELECTED_OPACITY;
      } else {
        mat.color.set(baseColor);
        mat.opacity = this.selectedId ? DIM_OPACITY : DEFAULT_OPACITY;
      }
    }
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
    this._highlightSelected();
  }

  // ── Dispose ──────────────────────────────────────────────
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.container.remove();
  }
}
