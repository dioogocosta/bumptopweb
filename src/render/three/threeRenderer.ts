/**
 * Adapter de render — three.js.
 *
 * Implementa a porta `IRenderer`. O render do BumpTop é deliberadamente simples:
 * caixas (ícones), piso/paredes texturizados, labels via DOM. Sem shaders custom
 * (o original usava OpenGL imediato fixed-function; three.js resolve limpo).
 */
import * as THREE from 'three';
import type {
  CameraState,
  IRenderer,
  ObjectHandle,
  Pose,
  RoomConfig,
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
  private floorMat?: THREE.MeshLambertMaterial;
  private wallMat?: THREE.MeshLambertMaterial;

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
    // Piso com textura clássica BumpTop (círculos concêntricos + feixe de luz)
    const floorGeo = new THREE.PlaneGeometry(halfSize * 2, halfSize * 2);
    const floorTexture = this.createBumpTopFloorTexture();
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTexture, color: 0xffffff });
    this.floorMat = floorMat;
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 4 paredes — tom azul ardósia clássico BumpTop
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3d648f });
    this.wallMat = wallMat;
    const mkWall = (w: number, h: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, h / 2, z);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    mkWall(halfSize * 2, wallHeight, wallThickness, 0, -halfSize);
    mkWall(halfSize * 2, wallHeight, wallThickness, 0, halfSize);
    mkWall(wallThickness, wallHeight, halfSize * 2, -halfSize, 0);
    mkWall(wallThickness, wallHeight, halfSize * 2, halfSize, 0);
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

  /** Thumbnail (dataURL) na face de CIMA (+Y) da caixa; null remove a textura. */
  setTexture(handle: ObjectHandle, dataUrl: string | null): void {
    const m = this.meshes.get(handle);
    if (!m) return;
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
    if (theme.name === 'BumpTop') {
      this.floorMat?.color.setHex(0xffffff); // Mantém o degradê claro e o feixe de luz sem escurecer
    } else {
      this.floorMat?.color.setHex(theme.floor);
    }
    this.wallMat?.color.setHex(theme.wall);
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
