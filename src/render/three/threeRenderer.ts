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
  KanbanLane,
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
  private roomMats = new Map<
    string,
    {
      floor: THREE.MeshLambertMaterial;
      wall: THREE.MeshLambertMaterial;
      edges?: THREE.LineSegments[];
    }
  >();
  private bumpTopTexture: THREE.CanvasTexture | null = null;
  private floorBuildingTexture: THREE.CanvasTexture | null = null;
  private infiniteFloorMesh: THREE.Mesh | null = null;
  private infiniteGridTexture: THREE.CanvasTexture | null = null;
  /** Tema ativo (guardado para aplicar ao criar novas salas lazily). */
  private activeTheme: Theme | null = null;
  /** PR4.3 — raias Kanban por sala (chave room:ox|oz). */
  private roomKanbanLines = new Map<string, THREE.Mesh[]>();
  /** PR4.6 — labels HTML das raias Kanban (chave room:ox|oz). */
  private roomKanbanLabels = new Map<string, HTMLElement[]>();
  /** PR4.6 — config de raias ativas por caixa (para reaplicar via setRoomLanes). */
  private roomKanbanConfig = new Map<string, KanbanLane[]>();
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

    // Piso infinito / grade ampla cibernética (visível no tema Floor)
    const infGeo = new THREE.PlaneGeometry(5000, 5000);
    if (!this.infiniteGridTexture) {
      this.infiniteGridTexture = this.createInfiniteGridTexture();
    }
    const infMat = new THREE.MeshLambertMaterial({
      map: this.infiniteGridTexture,
      transparent: true,
      opacity: 0.95,
      depthWrite: true,
    });
    this.infiniteFloorMesh = new THREE.Mesh(infGeo, infMat);
    this.infiniteFloorMesh.rotation.x = -Math.PI / 2;
    this.infiniteFloorMesh.position.set(0, -0.06, 0);
    this.infiniteFloorMesh.receiveShadow = true;
    this.infiniteFloorMesh.visible = false;
    this.scene.add(this.infiniteFloorMesh);

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
    // As paredes Norte e Sul cobrem a extensão externa total (halfSize * 2 + wallThickness * 2),
    // abraçando as paredes Oeste e Leste sem degraus nem quinas salientes.
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3d648f });
    const wallEdgesList: THREE.LineSegments[] = [];

    const mkWall = (w: number, h: number, d: number, x: number, z: number) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, wallMat);
      m.position.set(ox + x, h / 2, oz + z);
      m.receiveShadow = true;
      group.add(m);

      // Arestas de neon cibernético para o tema Floor (invisíveis por padrão nos demais temas)
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
      });
      const edges = new THREE.LineSegments(edgeGeo, edgeMat);
      edges.position.copy(m.position);
      edges.visible = false;
      group.add(edges);
      wallEdgesList.push(edges);
    };

    const spanX = (halfSize + wallThickness) * 2;
    const spanZ = halfSize * 2;
    const centerOffset = halfSize + wallThickness / 2;

    mkWall(spanX, wallHeight, wallThickness, 0, -centerOffset);
    mkWall(spanX, wallHeight, wallThickness, 0, +centerOffset);
    mkWall(wallThickness, wallHeight, spanZ, -centerOffset, 0);
    mkWall(wallThickness, wallHeight, spanZ, +centerOffset, 0);
    this.scene.add(group);
    // PR4.2 — materiais por caixa (o setTheme pinta TODAS as caixas)
    this.roomMats.set(group.name, { floor: floorMat, wall: wallMat, edges: wallEdgesList });
    // Aplica o tema ativo imediatamente (evita sala nascendo com tema errado em lazy rendering)
    if (this.activeTheme) this.setTheme(this.activeTheme);
  }

  /** Define a visibilidade do chão + 4 paredes de uma caixa. */
  setRoomVisible(room: RoomConfig, visible: boolean): void {
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const group = this.roomGroups.get(key);
    if (group) group.visible = visible;
    // Raias Kanban ficam dentro do group, então group.visible já cobre.
    // Mas labels HTML (caso existam fora do group) também:
    const labels = this.roomKanbanLabels.get(key);
    if (labels) for (const l of labels) l.style.display = visible ? '' : 'none';
    const dash = this.roomDashboards.get(key);
    if (dash) dash.mesh.visible = visible;
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
    const matEntry = this.roomMats.get(key);
    if (matEntry?.edges) {
      for (const e of matEntry.edges) {
        e.geometry?.dispose?.();
        (e.material as THREE.Material)?.dispose?.();
      }
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
    if (type === 'kanban' || type === 'sprint') {
      // Raias padrão (3 colunas) — serão sobrescritas por setRoomLanes se houver config
      const defaultLanes: KanbanLane[] = [
        { label: 'A Fazer',       color: '#1e3a5f', statusNames: ['new', 'ready', 'a fazer', 'backlog'] },
        { label: 'Em andamento',  color: '#7c3100', statusNames: ['in progress', 'em andamento', 'doing'] },
        { label: 'Concluído',     color: '#14532d', statusNames: ['done', 'closed', 'concluído', 'concluido'] },
      ];
      this.addKanbanLanes(group, room, defaultLanes);
    } else if (type === 'root' || type === 'backlog') {
      this.addDashboard(group, room); // PR4.5: backlog também tem painel
    }
  }

  /** PR4.6 — reconfigura as raias Kanban com lanes customizadas. */
  setRoomLanes(room: RoomConfig, lanes: KanbanLane[]): void {
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const group = this.roomGroups.get(key);
    if (!group) return;
    // Limpa só raias (não o dashboard)
    this.clearKanbanOnly(key);
    this.addKanbanLanes(group, room, lanes);
  }

  private clearRoomSpecials(key: string): void {
    this.clearKanbanOnly(key);
    const dash = this.roomDashboards.get(key);
    if (dash) {
      this.scene.remove(dash.mesh);
      dash.mesh.geometry.dispose();
      dash.texture.dispose();
      this.roomDashboards.delete(key);
    }
  }

  private clearKanbanOnly(key: string): void {
    const lines = this.roomKanbanLines.get(key);
    if (lines) {
      for (const m of lines) this.scene.remove(m);
      this.roomKanbanLines.delete(key);
    }
    const labels = this.roomKanbanLabels.get(key);
    if (labels) {
      for (const l of labels) l.remove();
      this.roomKanbanLabels.delete(key);
    }
    this.roomKanbanConfig.delete(key);
  }

  /**
   * PR4.6 — cria N raias Kanban no chão da caixa.
   * Cada raia: divisória neon vertical + tarja colorida no chão + label HTML projetado.
   */
  private addKanbanLanes(group: THREE.Group, room: RoomConfig, lanes: KanbanLane[]): void {
    const { halfSize, wallHeight } = room;
    const ox = room.origin?.x ?? 0;
    const oz = room.origin?.z ?? 0;
    const key = `room:${ox}|${oz}`;
    const n = lanes.length;
    const laneW = (halfSize * 2) / n;
    const meshes: THREE.Mesh[] = [];

    for (let i = 0; i < n; i++) {
      const lane = lanes[i]!;
      const laneX = ox - halfSize + i * laneW;
      const hexColor = parseInt(lane.color.replace('#', ''), 16);

      // Piso colorido da raia (plano semi-transparente sobre o chão)
      const floorGeo = new THREE.PlaneGeometry(laneW - 0.5, halfSize * 2 - 0.5);
      const floorMat = new THREE.MeshLambertMaterial({
        color: hexColor,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.rotation.x = -Math.PI / 2;
      floorMesh.position.set(laneX + laneW / 2, 0.02, oz);
      group.add(floorMesh);
      meshes.push(floorMesh);

      // Divisória vertical (exceto a última raia)
      if (i < n - 1) {
        const divX = laneX + laneW;
        const divGeo = new THREE.BoxGeometry(0.3, wallHeight * 0.85, halfSize * 2);
        const divMat = new THREE.MeshLambertMaterial({
          color: hexColor,
          transparent: true,
          opacity: 0.6,
        });
        const divMesh = new THREE.Mesh(divGeo, divMat);
        divMesh.position.set(divX, wallHeight * 0.425, oz);
        divMesh.receiveShadow = true;
        group.add(divMesh);
        meshes.push(divMesh);

        // Aresta neon na divisória
        const edgeGeo = new THREE.EdgesGeometry(divGeo);
        const edgeMat = new THREE.LineBasicMaterial({ color: hexColor, transparent: true, opacity: 0.9 });
        const edges = new THREE.LineSegments(edgeGeo, edgeMat);
        edges.position.copy(divMesh.position);
        group.add(edges);
        // Cast to Mesh for type compatibility (LineSegments → store as Mesh-like)
        meshes.push(edges as unknown as THREE.Mesh);
      }

      // Label da raia em alta resolução (canvas texture nítida)
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 512;
      labelCanvas.height = 128;
      const ctx = labelCanvas.getContext('2d')!;
      ctx.clearRect(0, 0, 512, 128);
      // fundo arredondado com borda neon
      ctx.fillStyle = lane.color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(8, 8, 496, 112, 20);
      else ctx.rect(8, 8, 496, 112);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // texto
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 46px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(lane.label.toUpperCase(), 256, 64);

      const labelTex = new THREE.CanvasTexture(labelCanvas);
      labelTex.needsUpdate = true;

      // Placa vertical na parede de trás da raia (elevada, com distância mínima garantida do chão)
      const labelH = 6.5;
      const wallLabelGeo = new THREE.PlaneGeometry(laneW * 0.85, labelH);
      const wallLabelMat = new THREE.MeshBasicMaterial({
        map: labelTex,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const wallLabelMesh = new THREE.Mesh(wallLabelGeo, wallLabelMat);
      // PR4.11 — Eleva o texto acima do chão (~14 unidades de distância mínima) p/ evitar conflito com piso/wireframe
      const labelY = Math.max(14, Math.min(22, wallHeight * 0.32));
      wallLabelMesh.position.set(laneX + laneW / 2, labelY, oz - halfSize + 0.6);
      group.add(wallLabelMesh);
      meshes.push(wallLabelMesh);
    }

    this.roomKanbanLines.set(key, meshes);
    this.roomKanbanConfig.set(key, lanes);
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

  /** PR4.3/4.5 — atualiza o texto do dashboard ROOT/BACKLOG de uma sala. */
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

    // PR4.5 — caixa BACKLOG: contagens por status do Taiga (quadradinho
    // colorido + nome + nº) em vez das linhas de itens/pastas/notas.
    if (data.statuses && data.statuses.length) {
      ctx.font = '14px monospace';
      ctx.textAlign = 'left';
      let y = 78;
      const larguraMax = canvas.width - 90;
      for (const st of data.statuses.slice(0, 8)) {
        ctx.fillStyle = st.color || '#8b5cf6';
        ctx.fillRect(46, y - 13, 16, 16);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(46, y - 13, 16, 16);
        ctx.fillStyle = '#e0e0e0';
        const nome = st.name.length > 24 ? `${st.name.slice(0, 23)}…` : st.name;
        ctx.fillText(`${nome}`, 72, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#9fd0ff';
        ctx.fillText(String(st.count), larguraMax + 46, y);
        ctx.textAlign = 'left';
        y += 30;
      }
      // rodapé: slug do projeto Taiga
      if (data.extra) {
        ctx.fillStyle = '#6a7f92';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        const slug = data.extra.length > 34 ? `${data.extra.slice(0, 33)}…` : data.extra;
        ctx.fillText(`Taiga: ${slug}`, canvas.width / 2, canvas.height - 18);
      }
      dash.texture.needsUpdate = true;
      return;
    }

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

  private createFloorBuildingTexture(): THREE.CanvasTexture {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // 1. Fundo escuro azul-noite profundo tecnológico (mesmo design do prédio 3D)
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.75);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#070b12');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 2. Grade quadriculada com linhas transparentes (design system Floor)
    const step = 64;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.20)';

    for (let x = 0; x <= size; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let y = 0; y <= size; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }

    // 3. Subdivisões mais finas
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    for (let x = 0; x <= size; x += 16) {
      if (x % step === 0) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let y = 0; y <= size; y += 16) {
      if (y % step === 0) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }

    // 4. Marcadores cibernéticos (+) nos nós da grade
    ctx.fillStyle = 'rgba(99, 179, 237, 0.5)';
    for (let x = step * 2; x < size; x += step * 2) {
      for (let y = step * 2; y < size; y += step * 2) {
        ctx.fillRect(x - 3, y - 0.5, 7, 1);
        ctx.fillRect(x - 0.5, y - 3, 1, 7);
      }
    }

    // 5. Círculos concêntricos sutis de radar no centro
    const cx = size / 2;
    const cy = size / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.38, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.18, 0, Math.PI * 2);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(99, 179, 237, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Textura procedural repetível para o chão infinito quadriculado (tema Floor). */
  private createInfiniteGridTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Fundo azul petróleo escuro cibernético
    ctx.fillStyle = '#0a0f16';
    ctx.fillRect(0, 0, size, size);

    // Subdivisões mais finas
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
    const sub = size / 4;
    for (let p = sub; p < size; p += sub) {
      ctx.beginPath();
      ctx.moveTo(p, 0); ctx.lineTo(p, size);
      ctx.moveTo(0, p); ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Linhas mestras quadriculadas transparentes
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.24)';
    ctx.strokeRect(0, 0, size, size);

    // Cruzes cibernéticas (+) nas interseções dos cantos e centro
    ctx.fillStyle = 'rgba(99, 179, 237, 0.55)';
    const drawCross = (x: number, y: number) => {
      ctx.fillRect(x - 4, y - 0.75, 8, 1.5);
      ctx.fillRect(x - 0.75, y - 4, 1.5, 8);
    };
    drawCross(0, 0);
    drawCross(size, 0);
    drawCross(0, size);
    drawCross(size, size);
    drawCross(size / 2, size / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(160, 160);
    return tex;
  }

  private getFloorTextureForTheme(themeName: string): THREE.CanvasTexture {
    if (themeName === 'Floor') {
      if (!this.floorBuildingTexture) this.floorBuildingTexture = this.createFloorBuildingTexture();
      return this.floorBuildingTexture;
    }
    if (!this.bumpTopTexture) this.bumpTopTexture = this.createBumpTopFloorTexture();
    return this.bumpTopTexture;
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
    this.activeTheme = theme;
    this.scene.background = new THREE.Color(theme.background);
    const isFloor = theme.name === 'Floor';
    const isBumpTop = theme.name === 'BumpTop';

    // Piso infinito quadriculado em todo o mundo 3D visível no tema Floor
    if (this.infiniteFloorMesh) {
      this.infiniteFloorMesh.visible = isFloor;
    }

    for (const { floor, wall, edges } of this.roomMats.values()) {
      if (isFloor) {
        floor.map = this.getFloorTextureForTheme('Floor');
        floor.color.setHex(0xffffff);

        // Parede translúcida vítrea + arestas de neon (idêntico à pilha do prédio 3D)
        wall.color.setHex(0x162334);
        wall.transparent = true;
        wall.opacity = 0.28;
        wall.depthWrite = false;
        wall.needsUpdate = true;
        if (edges) {
          for (const edge of edges) edge.visible = true;
        }
      } else if (isBumpTop) {
        floor.map = this.getFloorTextureForTheme('BumpTop');
        floor.color.setHex(0xffffff);

        wall.color.setHex(theme.wall);
        wall.transparent = false;
        wall.opacity = 1.0;
        wall.depthWrite = true;
        wall.needsUpdate = true;
        if (edges) {
          for (const edge of edges) edge.visible = false;
        }
      } else {
        floor.map = null;
        floor.color.setHex(theme.floor);

        wall.color.setHex(theme.wall);
        wall.transparent = false;
        wall.opacity = 1.0;
        wall.depthWrite = true;
        wall.needsUpdate = true;
        if (edges) {
          for (const edge of edges) edge.visible = false;
        }
      }
      floor.needsUpdate = true;
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
