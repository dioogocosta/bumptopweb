/**
 * Adapter de render — three.js.
 *
 * Implementa a porta `IRenderer`. O render do BumpTop é deliberadamente simples:
 * caixas (ícones), piso/paredes texturizados, labels via DOM. Sem shaders custom
 * (o original usava OpenGL imediato fixed-function; three.js resolve limpo).
 */
import * as THREE from 'three';
import type {
  BoxType,
  CameraState,
  IRenderer,
  ObjectHandle,
  Pose,
  RoomConfig,
  RoomDashboardData,
  Theme,
  Vec3,
} from '@core/ports/index';

export class ThreeRenderer implements IRenderer {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private meshes = new Map<ObjectHandle, THREE.Mesh>();
  private nextHandle = 1;
  private camState!: CameraState;
  private raycaster = new THREE.Raycaster();
  private width = 1;
  private height = 1;
  private highlightMat = new Map<ObjectHandle, THREE.MeshLambertMaterial>();
  private topMat = new Map<ObjectHandle, THREE.MeshLambertMaterial>();
  /** PR26 — handles com silhueta de pasta (setTexture pinta a face de cima). */
  private folderHandles = new Set<ObjectHandle>();
  /** Painel de vidro da pilha aberta em grade (PR9). */
  private pilePanel: THREE.Mesh | null = null;
  private roomGroups = new Map<string, THREE.Group>();
  private roomMats = new Map<string, { floor: THREE.MeshLambertMaterial; wall: THREE.MeshLambertMaterial }>();
  /** PR4.3 — raias Kanban por sala (chave room:ox|oz). */
  private roomKanbanLines = new Map<string, THREE.Mesh[]>();
  /** PR4.3 — dashboards ROOT por sala (canvas pixel-voxel na parede). */
  private roomDashboards = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; mesh: THREE.Mesh }>();

  async init(sceneRoot: HTMLElement, room: RoomConfig): Promise<void> {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x16283a);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
    this.camState = { target: { x: 0, y: 0, z: -10 }, distance: 210, azimuth: 0, elevation: 1.08, fov: 48 };

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sceneRoot.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    // Iluminação: luz direcional marcante (sombras nítidas no piso) + ambiente
    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    dir.position.set(-45, 140, -35);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    const s = room.halfSize * 1.15;
    dir.shadow.camera.left = -s;
    dir.shadow.camera.right = s;
    dir.shadow.camera.top = s;
    dir.shadow.camera.bottom = -s;
    dir.shadow.camera.near = 10;
    dir.shadow.camera.far = 350;
    dir.shadow.bias = -0.0004;
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.40));

    this.applyCamera();
  }

  addRoom(room: RoomConfig): void {
    const { halfSize, wallHeight, wallThickness } = room;
    // PR4a — várias caixas lado a lado no mesmo mundo (cada uma com o seu
    // chão + 4 paredes); origem ausente = caixa original no centro.
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    // PR4.2 — cada caixa num Group (removível ao excluir a caixa)
    const group = new THREE.Group();
    group.name = `room:${ox}|${oz}`;
    this.roomGroups.set(group.name, group);
    // Piso com textura clássica BumpTop (círculos concêntricos + feixe de luz)
    const floorGeo = new THREE.PlaneGeometry(halfSize * 2, halfSize * 2);
    const floorTexture = this.createBumpTopFloorTexture();
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTexture, color: 0xffffff });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ox, 0, oz);
    floor.receiveShadow = true;
    group.add(floor);

    // 4 paredes — tom azul ardósia clássico BumpTop
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3d648f });
    const mkWall = (w: number, h: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(ox + x, h / 2, oz + z);
      m.receiveShadow = true;
      group.add(m);
    };
    mkWall(halfSize * 2, wallHeight, wallThickness, 0, -halfSize);
    mkWall(halfSize * 2, wallHeight, wallThickness, 0, halfSize);
    mkWall(wallThickness, wallHeight, halfSize * 2, -halfSize, 0);
    mkWall(wallThickness, wallHeight, halfSize * 2, halfSize, 0);
    this.scene.add(group);
    // PR4.2 — materiais por caixa (o setTheme pinta TODAS as caixas)
    this.roomMats.set(group.name, { floor: floorMat, wall: wallMat });
  }

  /** PR4.2 — remove o chão + 4 paredes da caixa (meshes + materiais). */
  removeRoom(room: RoomConfig): void {
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const group = this.roomGroups.get(key);
    if (!group) return;
    this.scene.remove(group);
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
    }
    this.roomGroups.delete(key);
    this.roomMats.delete(key);
  }

  /** PR4.3 — aplica o visual especial de uma caixa pelo tipo. */
  setRoomType(room: RoomConfig, type: BoxType): void {
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const group = this.roomGroups.get(key);
    if (!group) return;
    this.clearRoomSpecials(key);
    if (type === 'kanban') this.addKanbanLines(group, room);
    else if (type === 'root') this.addDashboard(group, room);
  }

  private clearRoomSpecials(key: string): void {
    const lines = this.roomKanbanLines.get(key);
    if (lines) {
      for (const m of lines) this.scene.remove(m);
      this.roomKanbanLines.delete(key);
    }
    const dash = this.roomDashboards.get(key);
    if (dash) {
      this.scene.remove(dash.mesh);
      dash.mesh.geometry.dispose();
      dash.texture.dispose();
      this.roomDashboards.delete(key);
    }
  }

  private addKanbanLines(group: THREE.Group, room: RoomConfig): void {
    const { halfSize, wallHeight } = room;
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const w = (halfSize * 2) / 3;
    const color = 0x2a4a6e;
    const mat = new THREE.MeshLambertMaterial({ color });
    const lines: THREE.Mesh[] = [];
    for (let i = 1; i <= 2; i++) {
      const x = ox - halfSize + i * w;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, wallHeight * 0.9, halfSize * 2), mat);
      m.position.set(x, wallHeight * 0.45, oz);
      m.receiveShadow = true;
      group.add(m);
      lines.push(m);
    }
    this.roomKanbanLines.set(key, lines);
  }

  private addDashboard(group: THREE.Group, room: RoomConfig): void {
    const { halfSize, wallHeight, wallThickness } = room;
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(halfSize * 1.6, wallHeight * 0.6), new THREE.MeshLambertMaterial({ map: texture, transparent: true, opacity: 0.95 }));
    mesh.position.set(ox, wallHeight * 0.55, oz - halfSize + wallThickness / 2 + 0.05);
    mesh.lookAt(ox, wallHeight * 0.55, oz - halfSize - 10);
    group.add(mesh);
    this.roomDashboards.set(key, { canvas, ctx, texture, mesh });
  }

  /** PR4.3 — atualiza o texto do dashboard ROOT de uma sala. */
  setRoomDashboard(room: RoomConfig, data: RoomDashboardData): void {
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const dash = this.roomDashboards.get(key);
    if (!dash) return;
    const { canvas, ctx } = dash;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0b1520';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#4a90e2';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(data.name, canvas.width / 2, 40);
    ctx.font = '16px monospace';
    const linhas = [
      `Itens: ${data.itens}`,
      `Pastas: ${data.pastas}`,
      `Notas: ${data.notas}`,
      `Pilhas: ${data.pilhas}`,
    ];
    let y = 90;
    for (const l of linhas) {
      ctx.fillText(l, canvas.width / 2, y);
      y += 34;
    }
    dash.texture.needsUpdate = true;
  }

  /** PR4.3 — remove raias/dashboard de uma sala ao exclui-la. */
  removeRoomSpecials(key: string): void {
    this.clearRoomSpecials(key);
  }

  private createBumpTopFloorTexture(): THREE.CanvasTexture {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // 1. Fundo com gradiente radial azul-acinzentado BumpTop
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.75);
    grad.addColorStop(0, '#7b9ec3');
    grad.addColorStop(1, '#5d82a8');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 2. Feixe de luz diagonal suave (top-left -> bottom-right)
    const beam = ctx.createLinearGradient(0, 0, size, size);
    beam.addColorStop(0, 'rgba(255, 255, 255, 0)');
    beam.addColorStop(0.35, 'rgba(255, 255, 255, 0.05)');
    beam.addColorStop(0.5, 'rgba(255, 255, 255, 0.22)');
    beam.addColorStop(0.65, 'rgba(255, 255, 255, 0.05)');
    beam.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, size, size);

    // 3. Círculos concêntricos BumpTop no centro da mesa
    const cx = size / 2;
    const cy = size / 2;

    // Círculo externo
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // Círculo intermediário pontilhado
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.26, 0, Math.PI * 2);
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Círculo central
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.11, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 3.0;
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  addBox(id: string, halfExtents: Vec3, color: string): ObjectHandle {
    const geo = new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
    // Borda das fichas em papel limpo (#f8fafc) p/ visual de papel empilhado nas pilhas
    const sideMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });
    const bottomMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
    const topMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
    const mats = [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat];
    const mesh = new THREE.Mesh(geo, mats);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    const handle = this.nextHandle++ as ObjectHandle;
    this.meshes.set(handle, mesh);
    this.highlightMat.set(handle, topMat);
    void id;
    return handle;
  }

  setPose(handle: ObjectHandle, pose: Pose): void {
    const m = this.meshes.get(handle);
    if (!m) return;
    m.position.set(pose.position.x, pose.position.y, pose.position.z);
    m.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
  }

  setVisible(handle: ObjectHandle, visible: boolean): void {
    const m = this.meshes.get(handle);
    if (m) m.visible = visible;
  }

  isVisible(handle: ObjectHandle): boolean {
    return this.meshes.get(handle)?.visible ?? false;
  }

  setHighlight(handle: ObjectHandle, highlighted: boolean): void {
    // Verde BumpTop suave (0x1b5e20) sem ofuscar a textura de papel do card
    const hex = highlighted ? 0x1b5e20 : 0x000000;
    for (const mat of [this.highlightMat.get(handle), this.topMat.get(handle)]) {
      mat?.emissive.setHex(hex);
    }
  }

  /** Escala a caixa em volta do próprio centro (half-extents base × escala). */
  setScale(handle: ObjectHandle, scale: number): void {
    const m = this.meshes.get(handle);
    if (m && Number.isFinite(scale) && scale > 0) m.scale.setScalar(scale);
  }

  /**
   * PR26 — pasta com SILHUETA 3D de verdade (recortada, como no BumpTop
   * original): substitui a geometria da caixa por corpo + ABA extrudados.
   * As proporções seguem a textura pixel (aba = 4/26 da altura, faixa à
   * esquerda ~6%..48% da largura), então a face pixelada casa com o recorte.
   * A física continua na caixa original (visual levemente menor = ok).
   */
  setFolderShape(handle: ObjectHandle, halfExtents: Vec3): void {
    const m = this.meshes.get(handle);
    if (!m) return;
    const W = halfExtents.x * 2;
    const D = halfExtents.z * 2;
    const T = Math.max(0.24, halfExtents.y * 2); // espessura do "papel"

    // Contorno CCW: corpo + aba (mesmas proporções da textura pixel)
    const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, yTop = D / 2;
    const bodyTop = yTop - D * (4 / 26);
    const tabL = x0 + W * 0.0625, tabR = x0 + W * 0.4844;
    const contour: Array<{ x: number; y: number }> = [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: bodyTop },
      { x: tabR, y: bodyTop }, { x: tabR, y: yTop }, { x: tabL, y: yTop },
      { x: tabL, y: bodyTop }, { x: x0, y: bodyTop },
  ];
    const tris = THREE.ShapeUtils.triangulateShape(
      contour.map((p) => new THREE.Vector2(p.x, p.y)),
      [],
    );

    // UV da face superior: casa o recorte com a textura pixel 32×32
    // (o recorte cobre as linhas 2..27 da textura; v cresce de baixo p/ cima)
    const uvFor = (x: number, y: number): [number, number] => {
      const row = 2.5 + ((yTop - y) / D) * 25; // y=yTop → linha 2.5; y=y0 → 27.5
      return [(x - x0) / W, (31 - row) / 32];
    };

    const pos: number[] = [];
    const uvs: number[] = [];
    const push = (p: { x: number; y: number }, z: number, uv: [number, number]) => {
      pos.push(p.x, p.y, z);
      uvs.push(uv[0], uv[1]);
    };
    // Face de cima (z=+T/2, material 0 — textura)
    const topStart = 0;
    for (const [a, b, c] of tris) {
      for (const i of [a, b, c]) push(contour[i], T / 2, uvFor(contour[i].x, contour[i].y));
    }
    const topCount = pos.length / 3;
    // Face de baixo (z=−T/2, material 1) — mesma silhueta, ordem invertida
    for (const [a, b, c] of tris) {
      for (const i of [a, c, b]) push(contour[i], -T / 2, [0, 0]);
    }
    // Laterais (material 1): um quad por aresta do contorno
    for (let i = 0; i < contour.length; i++) {
      const p1 = contour[i], p2 = contour[(i + 1) % contour.length];
      pos.push(p1.x, p1.y, -T / 2, p2.x, p2.y, -T / 2, p2.x, p2.y, T / 2);
      uvs.push(0, 1, 1, 1, 1, 0);
      pos.push(p1.x, p1.y, -T / 2, p2.x, p2.y, T / 2, p1.x, p1.y, T / 2);
      uvs.push(0, 1, 1, 0, 0, 0);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.addGroup(topStart, topCount, 0); // face de cima → material 0
    geo.addGroup(topCount, pos.length / 3 - topCount, 1); // baixo+laterais → 1
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2); // deita: contorno no chão, espessura p/ cima

    m.geometry.dispose();
    m.geometry = geo;
    const top = new THREE.MeshLambertMaterial({ color: 0x5aa7e8 });
    const side = new THREE.MeshLambertMaterial({ color: 0x123657 });
    m.material = [top, side];
    this.meshes.set(handle, m);
    this.highlightMat.set(handle, top); // seleção (emissive) na face de cima
    this.topMat.set(handle, top); // setTexture aplica a textura aqui
    this.folderHandles.add(handle);
  }

  /** Thumbnail (dataURL) na face de CIMA (+Y) da caixa; null remove a textura. */
  setTexture(handle: ObjectHandle, dataUrl: string | null): void {
    const m = this.meshes.get(handle);
    if (!m) return;
    // PR26 — pasta: a textura vai direto no material da face de cima
    if (this.folderHandles.has(handle)) {
      const target = this.topMat.get(handle);
      if (!target) return;
      if (dataUrl === null) {
        target.map?.dispose();
        target.map = null;
        target.needsUpdate = true;
        return;
      }
      const loader = new THREE.TextureLoader();
      loader.load(dataUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        // Pixel art: filtro NEAREST evita o blur de minificação
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        target.map?.dispose();
        target.map = tex;
        target.color.setHex(0xffffff);
        target.needsUpdate = true;
      });
      return;
    }
    const mats = (
      Array.isArray(m.material) ? m.material : [m.material]
    ) as THREE.MeshLambertMaterial[];
    const base = this.highlightMat.get(handle) ?? mats[0];
    if (dataUrl === null) {
      const top = this.topMat.get(handle);
      if (top) {
        top.map?.dispose();
        top.dispose();
        this.topMat.delete(handle);
        mats[2] = base; // face topo volta à cor sólida
        m.material = mats;
      } else {
        base.map?.dispose();
        base.map = null;
        base.needsUpdate = true;
      }
      return;
    }
    let top = this.topMat.get(handle);
    if (!top) {
      top = base.clone(); // herda cor + estado de highlight atual
      this.topMat.set(handle, top);
      mats[2] = top;
      m.material = mats;
    }
    const target = top;
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      target.map?.dispose(); // troca de thumbnail → libera a anterior
      target.map = tex;
      target.color.setHex(0xffffff); // Mantém o fundo do papel branco puro, sem tintura colorida
      target.needsUpdate = true;
    });
  }

  remove(handle: ObjectHandle): void {
    const m = this.meshes.get(handle);
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of new Set(mats)) {
      // Set: as 6 faces podem apontar p/ o mesmo material
      (mat as THREE.MeshLambertMaterial).map?.dispose();
      mat.dispose();
    }
    this.meshes.delete(handle);
    this.highlightMat.delete(handle);
    this.topMat.delete(handle);
    this.folderHandles.delete(handle);
  }

  /**
   * Painel de "vidro" sob uma pilha aberta em grade (PR9): plano translúcido
   * sobre o piso (y≈0.06), sob os itens da grade. null esconde/remove.
   */
  setPilePanel(panel: { x: number; z: number; hw: number; hd: number } | null): void {
    if (!panel) {
      if (this.pilePanel) {
        this.scene.remove(this.pilePanel);
        this.pilePanel.geometry.dispose();
        (this.pilePanel.material as THREE.Material).dispose();
        this.pilePanel = null;
      }
      return;
    }
    if (!this.pilePanel) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x9ecbff,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.pilePanel = new THREE.Mesh(geo, mat);
      this.pilePanel.rotation.x = -Math.PI / 2;
      this.pilePanel.position.y = 0.06;
      this.pilePanel.renderOrder = -1;
      this.scene.add(this.pilePanel);
    }
    this.pilePanel.scale.set(Math.max(0.1, panel.hw * 2), Math.max(0.1, panel.hd * 2), 1);
    this.pilePanel.position.x = panel.x;
    this.pilePanel.position.z = panel.z;
  }

  setCamera(state: CameraState): void {
    this.camState = state;
    this.applyCamera();
  }

  getCamera(): CameraState {
    return { ...this.camState, target: { ...this.camState.target } };
  }

  /** Canvas WebGL — p/ o input adapter capturar eventos. */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setTheme(theme: Theme): void {
    this.scene.background = new THREE.Color(theme.background);
    const floorColor = theme.name === 'BumpTop' ? 0xffffff : theme.floor;
    // PR4.2 — pinta o chão/paredes de TODAS as caixas
    for (const { floor, wall } of this.roomMats.values()) {
      floor.color.setHex(floorColor);
      wall.color.setHex(theme.wall);
    }
  }

  private applyCamera(): void {
    const { target, distance, azimuth, elevation, fov } = this.camState;
    const cosEl = Math.cos(elevation);
    this.camera.position.set(
      target.x + distance * cosEl * Math.sin(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + distance * cosEl * Math.cos(azimuth),
    );
    this.camera.lookAt(target.x, target.y, target.z);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  projectToScreen(p: Vec3): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.width,
      y: (-v.y * 0.5 + 0.5) * this.height,
      visible: v.z < 1,
    };
  }

  screenToRay(screen: { x: number; y: number }): { origin: Vec3; direction: Vec3 } {
    const ndc = new THREE.Vector2(
      (screen.x / this.width) * 2 - 1,
      -(screen.y / this.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    return {
      origin: { x: o.x, y: o.y, z: o.z },
      direction: { x: d.x, y: d.y, z: d.z },
    };
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const handle of [...this.meshes.keys()]) this.remove(handle);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
